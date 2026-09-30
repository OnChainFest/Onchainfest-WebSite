import {
  type Capability,
  type CriterionKind,
  type CriterionStatus,
  type EvidenceType,
  type RecognitionLevel,
  type VerificationFlag,
  type VerificationLevel,
} from '@br/domain';
import {
  ALL_RECOGNITION_LEVELS,
  EvaluationContext,
  levelsAtOrAbove,
  recognitionRank,
  type AuthoritySubject,
  type TraceDecision,
} from './context';
import { OFFICIAL_DECLARATION_CAPABILITIES, param, type PolicyCriterion } from './policy';
import { notSupported, Reason } from './reasons';
import type {
  SignedFact,
  SnapshotAttestation,
  SnapshotEvidence,
  VerificationSnapshot,
} from './snapshot';

/** Per-criterion explanation (internal trace; never served publicly as-is). */
export interface CriterionResult {
  readonly criterionId: string;
  readonly kind: CriterionKind | 'DERIVED_INPUT_LEVELS';
  readonly level: VerificationLevel;
  readonly status: CriterionStatus;
  readonly reasons: readonly string[];
  readonly observed?: number;
  readonly required?: number;
  readonly supportingAttestationIds?: readonly string[];
  readonly supportingEvidenceIds?: readonly string[];
  readonly authority?: readonly TraceDecision[];
  readonly issuerGroups?: readonly {
    readonly principalId: string;
    readonly attestationIds: readonly string[];
    readonly classification: string;
    readonly reasons?: readonly string[];
  }[];
  readonly sourceGroups?: readonly {
    readonly groupKey: string;
    readonly evidenceIds: readonly string[];
    readonly classification: string;
  }[];
  readonly participation?: readonly {
    readonly principalId: string;
    readonly relation: string;
    readonly participantId?: string;
    readonly timing?: string;
  }[];
}

type Partial_ = Omit<CriterionResult, 'criterionId' | 'kind' | 'level'>;

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const subjectOf = (f: SignedFact): AuthoritySubject => ({
  principalId: f.issuerPrincipalId,
  keyId: f.keyId,
  ...(f.signedAt === undefined ? {} : { signedAt: f.signedAt }),
  atTime: f.issuedAt,
  factId: f.attestationId,
});
const RESULT_CLAIMS = new Set(['RESULT_ACCURATE', 'RESULT_OFFICIAL']);
const INVALIDATING = new Set(['INTEGRITY_FAILED', 'MANIPULATED', 'WRONG_SUBJECT']);

/**
 * Generic machine derivation (BRT-01 E-4): AI_DERIVED evidence, AI pipelines, and OCR/AI generators.
 * Certified machine evidence (§2.6: registered SYSTEM + DEVICE_KEY + grant + approved configuration)
 * has no producer yet, so nothing is treated as certified machine evidence in BRT-07.
 */
export function isGenericMachineDerived(e: SnapshotEvidence): boolean {
  return (
    e.evidenceType === 'AI_DERIVED' ||
    e.sourceKind === 'AI_PIPELINE' ||
    e.generatorKind === 'AI_PIPELINE' ||
    e.generatorKind === 'OCR'
  );
}

interface OfficialDeclaration {
  readonly status: CriterionStatus;
  readonly reasons: string[];
  readonly supporting: string[];
  readonly authority: TraceDecision[];
  /** Certifying authority subjects (for the V3 sanction-root check). */
  readonly certifying: { subject: AuthoritySubject; capability: Capability }[];
}

interface PrimaryEvidence {
  readonly counted: SnapshotEvidence[];
  readonly excluded: { evidence: SnapshotEvidence; reason: string }[];
  readonly declaredTypes: readonly EvidenceType[];
  readonly aiOnly: boolean;
}

/** Criterion evaluators over one snapshot (memoized shared sub-computations). */
export class Criteria {
  private readonly ctx: EvaluationContext;
  private readonly s: VerificationSnapshot;
  readonly flags = new Set<VerificationFlag>();
  private readonly officialMemo = new Map<string, OfficialDeclaration>();
  private primaryMemo: PrimaryEvidence | undefined;
  private sanctionMemo:
    (Partial_ & { anchors: { anchorId: string; level: RecognitionLevel }[] }) | undefined;

  private readonly availability: readonly string[];

  constructor(ctx: EvaluationContext, primaryCriterion?: PolicyCriterion) {
    this.ctx = ctx;
    this.s = ctx.snapshot;
    this.availability =
      primaryCriterion === undefined
        ? ['AVAILABLE', 'ARCHIVED']
        : param(primaryCriterion, 'availability', ['AVAILABLE', 'ARCHIVED']);
    for (const f of this.allSignedFacts())
      if (this.ctx.keyTrust(f).trust === 'SUSPECT') this.flags.add('SUSPECT_ATTESTER');
    if (!this.s.participation.sidesComplete) this.flags.add('PARTICIPATION_INCOMPLETE');
    if (this.activeDenies().length > 0) this.flags.add('CONTRADICTING_ATTESTATION');
  }

  allSignedFacts(): SignedFact[] {
    return [
      ...(this.s.attestations ?? []),
      ...(this.s.sanctions ?? []),
      ...(this.s.identityConfirmations ?? []),
      ...(this.s.ratifications ?? []),
    ];
  }

  private resultClaims(polarity: 'AFFIRM' | 'DENY', claimType?: string): SnapshotAttestation[] {
    return (this.s.attestations ?? []).filter(
      (a) =>
        a.polarity === polarity &&
        (claimType === undefined ? RESULT_CLAIMS.has(a.claimType) : a.claimType === claimType) &&
        this.ctx.counts(a),
    );
  }

  /** Active dispute CLAIMS: counting DENY result claims (not Dispute entities — ADR-0007). */
  activeDenies(): SnapshotAttestation[] {
    return this.resultClaims('DENY');
  }

  private groupByIssuer<T extends SignedFact>(facts: readonly T[]): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const f of [...facts].sort((a, b) => (a.attestationId < b.attestationId ? -1 : 1))) {
      const g = groups.get(f.issuerPrincipalId) ?? [];
      g.push(f);
      groups.set(f.issuerPrincipalId, g);
    }
    return groups;
  }

  // ───────────────────────────── V0 ─────────────────────────────

  claimBound(): Partial_ {
    const known = (this.s.authority.principals ?? []).some(
      (p) => p.principalId === this.ctx.submitterId,
    );
    return known
      ? { status: 'PASS', reasons: [Reason.CLAIM_HASH_BOUND, Reason.SUBMITTER_KNOWN] }
      : { status: 'FAIL', reasons: [Reason.SUBMITTER_UNKNOWN] };
  }

  // ───────────────────────────── V1 ─────────────────────────────

  /**
   * BRT-01 V1: ≥ N RESULT_ACCURATE AFFIRM issuers independent of the submitter — a counterparty
   * (a principal CERTAINLY on another participant's side) or a REGISTERED OFFICIAL (a structural
   * REGISTERED_OFFICIAL fact covering the result's hierarchy at the attestation's issuedAt, on no
   * side, with no prohibited relation). V1's authority requirement is NONE: no AuthorityGrant is
   * consulted here, and ATTEST_RESULT never makes a principal a registered official.
   * Independence is PRINCIPAL-based: every key and every attestation of one principal is one group.
   * Unresolved / temporally undetermined participation never counts; unaffiliated third parties
   * have no standing. When no REGISTERED_OFFICIAL producer exists the official path is reported
   * as unavailable (NOT_SUPPORTED_REGISTERED_OFFICIAL) — the counterparty path is unaffected.
   */
  independentCorroboration(c: PolicyCriterion): Partial_ {
    const min = param(c, 'minIssuers', 1);
    const officialPath = this.ctx.supports('REGISTERED_OFFICIAL');
    const submitterSides = this.ctx.sidesOf(this.ctx.submitterId);
    const submitter = this.ctx.participation(this.ctx.submitterId);
    const submitterKnown =
      submitter?.resolution === 'RESOLVED' &&
      this.ctx.sideKnowledge(this.ctx.submitterId) === 'KNOWN';
    const groups: NonNullable<CriterionResult['issuerGroups']>[number][] = [];
    const participation: NonNullable<CriterionResult['participation']>[number][] = [];
    const supporting: string[] = [];
    let independent = 0;
    let unknown = 0;
    for (const [pid, facts] of this.groupByIssuer(this.resultClaims('AFFIRM', 'RESULT_ACCURATE'))) {
      const ids = facts.map((f) => f.attestationId);
      participation.push(...this.ctx.participationTrace(pid));
      const push = (classification: string, reasons: string[] = []) =>
        groups.push({ principalId: pid, attestationIds: ids, classification, reasons });
      if (pid === this.ctx.submitterId) {
        push(Reason.SUBMITTER_SELF);
        continue;
      }
      const info = this.ctx.participation(pid);
      if (info === undefined || info.resolution !== 'RESOLVED') {
        unknown += 1;
        push(
          Reason.PARTICIPATION_UNKNOWN,
          info?.resolution === 'TEMPORALLY_UNDETERMINED' ? [Reason.RELATION_TIME_UNDETERMINED] : [],
        );
        continue;
      }
      const sides = this.ctx.sidesOf(pid);
      if (sides.size > 0) {
        if (!submitterKnown) {
          unknown += 1;
          push(Reason.SUBMITTER_SIDE_UNKNOWN);
        } else if ([...sides].some((x) => submitterSides.has(x))) {
          push(Reason.SAME_SIDE_AS_SUBMITTER);
        } else {
          independent += 1;
          supporting.push(...ids);
          push(Reason.COUNTERPARTY);
        }
        continue;
      }
      // On no side: counts only as a REGISTERED OFFICIAL (structural fact; no authority involved).
      if (!officialPath) {
        push(Reason.NO_STANDING, [notSupported('REGISTERED_OFFICIAL')]);
        continue;
      }
      const registration = facts
        .map((f) => this.ctx.registeredOfficial(pid, f.issuedAt))
        .find((r) => r !== undefined);
      if (registration === undefined) {
        push(Reason.NO_STANDING, [Reason.NOT_REGISTERED_OFFICIAL]);
        continue;
      }
      const conflict = this.ctx.conflictStatus(pid);
      if (conflict === 'CONFLICTED')
        push(Reason.NO_STANDING, [Reason.REGISTERED_OFFICIAL_CONFLICTED]);
      else if (conflict === 'UNAVAILABLE') {
        unknown += 1;
        push(Reason.PARTICIPATION_UNKNOWN, [Reason.REGISTERED_OFFICIAL]);
      } else {
        independent += 1;
        supporting.push(...ids);
        push(Reason.REGISTERED_OFFICIAL);
      }
    }
    const status: CriterionStatus =
      independent >= min ? 'PASS' : independent + unknown >= min ? 'UNKNOWN' : 'FAIL';
    return {
      status,
      reasons: [
        independent >= min ? Reason.MINIMUM_MET : Reason.BELOW_MINIMUM,
        ...(status === 'UNKNOWN' ? [Reason.PARTICIPATION_UNKNOWN] : []),
        Reason.COUNTERPARTY_PATH_EVALUATED,
        officialPath
          ? Reason.REGISTERED_OFFICIAL_PATH_EVALUATED
          : notSupported('REGISTERED_OFFICIAL'),
      ],
      observed: independent,
      required: min,
      supportingAttestationIds: supporting,
      issuerGroups: groups,
      participation,
    };
  }

  /**
   * BRT-01 V1 "no unresolved DENY from a counterparty" reconciled with §5.3 ("a participant DENY
   * blocks V1 … it does not block V2, since a certifying official outranks a participant") and with
   * cumulative levels V2 ⇒ V1 ⇒ V0 (ADR-0005, ADR-0036):
   *
   *   · no counterparty / submitter DENY                          → PASS  NO_COUNTERPARTY_DENY
   *   · a counterparty DENY and the SAME evaluation fully meets the V2 certification exception
   *     (OFFICIAL_DECLARATION passes AND NO_AUTHORIZED_DENY passes) → PASS
   *       COUNTERPARTY_DENY_PRESENT + COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION
   *       + V2_OFFICIAL_DECLARATION_PASSED + V2_NO_AUTHORIZED_DENY_PASSED
   *   · otherwise                                                → FAIL (UNKNOWN for unresolved
   *       deniers) with COUNTERPARTY_DENY + V2_CERTIFICATION_EXCEPTION_NOT_MET
   *
   * The exception is explicit in the trace; an authorized official DENY is never outranked.
   */
  noCounterpartyDeny(v2Capabilities: readonly Capability[]): Partial_ {
    const groups: NonNullable<CriterionResult['issuerGroups']>[number][] = [];
    const participation: NonNullable<CriterionResult['participation']>[number][] = [];
    let blocking = 0;
    let unknown = 0;
    const denyIds: string[] = [];
    for (const [pid, facts] of this.groupByIssuer(this.activeDenies())) {
      const ids = facts.map((f) => f.attestationId);
      participation.push(...this.ctx.participationTrace(pid));
      if (pid === this.ctx.submitterId) {
        blocking += 1;
        denyIds.push(...ids);
        groups.push({
          principalId: pid,
          attestationIds: ids,
          classification: Reason.SUBMITTER_DENY,
        });
      } else if (this.ctx.sidesOf(pid).size > 0) {
        blocking += 1;
        denyIds.push(...ids);
        groups.push({
          principalId: pid,
          attestationIds: ids,
          classification: Reason.COUNTERPARTY_DENY,
        });
      } else if (this.ctx.sideKnowledge(pid) === 'UNKNOWN') {
        unknown += 1;
        denyIds.push(...ids);
        groups.push({
          principalId: pid,
          attestationIds: ids,
          classification: Reason.PARTICIPATION_UNKNOWN,
        });
      } else {
        groups.push({ principalId: pid, attestationIds: ids, classification: Reason.NO_STANDING });
      }
    }
    if (blocking === 0 && unknown === 0)
      return {
        status: 'PASS',
        reasons: [Reason.NO_COUNTERPARTY_DENY],
        issuerGroups: groups,
        participation,
      };
    const official = this.officialDeclaration(v2Capabilities);
    const authorizedDeny = this.noAuthorizedDeny();
    if (official.status === 'PASS' && authorizedDeny.status === 'PASS')
      return {
        status: 'PASS',
        reasons: [
          Reason.COUNTERPARTY_DENY_PRESENT,
          Reason.COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION,
          Reason.V2_OFFICIAL_DECLARATION_PASSED,
          Reason.V2_NO_AUTHORIZED_DENY_PASSED,
        ],
        observed: blocking + unknown,
        supportingAttestationIds: official.supporting,
        issuerGroups: groups,
        participation,
      };
    return {
      status: blocking > 0 ? 'FAIL' : 'UNKNOWN',
      reasons: [
        blocking > 0 ? Reason.COUNTERPARTY_DENY : Reason.PARTICIPATION_UNKNOWN,
        Reason.V2_CERTIFICATION_EXCEPTION_NOT_MET,
      ],
      observed: blocking + unknown,
      required: 0,
      supportingAttestationIds: denyIds,
      issuerGroups: groups,
      participation,
    };
  }

  /** Optional stricter criterion: any active dispute claim (counting DENY) blocks the level. */
  noActiveDispute(): Partial_ {
    const denies = this.activeDenies();
    return denies.length === 0
      ? { status: 'PASS', reasons: [Reason.NO_ACTIVE_DISPUTE_CLAIM] }
      : {
          status: 'FAIL',
          reasons: [Reason.ACTIVE_DISPUTE_CLAIM],
          observed: denies.length,
          required: 0,
          supportingAttestationIds: denies.map((d) => d.attestationId),
        };
  }

  // ───────────────────────────── V2 ─────────────────────────────

  /** Primary evidence: linked to THIS version as PRIMARY, of a discipline primary type, available. */
  private primary(): PrimaryEvidence {
    if (this.primaryMemo !== undefined) return this.primaryMemo;
    const availability = this.availability;
    const declaredTypes = this.s.discipline.primaryEvidenceTypes ?? [];
    const invalid = this.ctx.supports('EVIDENCE_ASSESSMENT')
      ? new Set(
          (this.s.evidenceAssessments ?? [])
            .filter((a) => INVALIDATING.has(a.finding))
            .map((a) => a.evidenceId),
        )
      : new Set<string>();
    const counted: SnapshotEvidence[] = [];
    const excluded: PrimaryEvidence['excluded'] = [];
    for (const e of this.s.evidence ?? []) {
      if (!(e.versionRoles ?? []).includes('PRIMARY')) continue;
      if (!declaredTypes.includes(e.evidenceType))
        excluded.push({ evidence: e, reason: Reason.TYPE_NOT_PRIMARY });
      else if (!availability.includes(e.availability)) {
        this.flags.add('EVIDENCE_UNAVAILABLE');
        excluded.push({ evidence: e, reason: Reason.EVIDENCE_UNAVAILABLE });
      } else if (invalid.has(e.evidenceId))
        excluded.push({ evidence: e, reason: Reason.INVALIDATING_ASSESSMENT });
      else counted.push(e);
    }
    const aiOnly = counted.length > 0 && counted.every(isGenericMachineDerived);
    this.primaryMemo = { counted, excluded, declaredTypes, aiOnly };
    return this.primaryMemo;
  }

  /** BRT-01 V2 evidence + E-4 (non-bypassable: generic AI can never be the only primary evidence). */
  primaryEvidence(c: PolicyCriterion): Partial_ {
    const min = param(c, 'minItems', 1);
    const p = this.primary();
    const ids = p.counted.map((e) => e.evidenceId);
    if (p.declaredTypes.length === 0)
      return {
        status: 'FAIL',
        reasons: [Reason.NO_PRIMARY_TYPES_DECLARED],
        observed: 0,
        required: min,
      };
    if (p.aiOnly) {
      this.flags.add('AI_ONLY_EVIDENCE');
      return {
        status: 'FAIL',
        reasons: [Reason.AI_ONLY_EVIDENCE],
        observed: p.counted.length,
        required: min,
        supportingEvidenceIds: ids,
      };
    }
    return {
      status: p.counted.length >= min ? 'PASS' : 'FAIL',
      reasons: uniq([
        p.counted.length >= min ? Reason.MINIMUM_MET : Reason.NO_PRIMARY_EVIDENCE,
        ...p.excluded.map((x) => x.reason),
      ]),
      observed: p.counted.length,
      required: min,
      supportingEvidenceIds: ids,
    };
  }

  /** Every counted primary item's content/descriptor hash was re-verified by the assembler. */
  primaryEvidenceIntegrity(): Partial_ {
    const p = this.primary();
    if (p.counted.length === 0)
      return { status: 'INSUFFICIENT', reasons: [Reason.NO_PRIMARY_EVIDENCE] };
    const ok = p.counted.every((e) => e.integrity === 'VERIFIED');
    return {
      status: ok ? 'PASS' : 'FAIL',
      reasons: [Reason.INTEGRITY_VERIFIED, Reason.SOURCE_SIGNATURE_NOT_APPLICABLE],
      supportingEvidenceIds: p.counted.map((e) => e.evidenceId),
    };
  }

  /**
   * BRT-01 "primary evidence … that has no invalidating assessment". Without an EvidenceAssessment
   * producer the absence cannot be distinguished from "never assessable", so it fails closed.
   */
  noInvalidatingAssessment(): Partial_ {
    if (!this.ctx.supports('EVIDENCE_ASSESSMENT'))
      return { status: 'INPUT_NOT_SUPPORTED', reasons: [notSupported('EVIDENCE_ASSESSMENT')] };
    const primaryIds = new Set(
      (this.s.evidence ?? [])
        .filter((e) => (e.versionRoles ?? []).includes('PRIMARY'))
        .map((e) => e.evidenceId),
    );
    const bad = (this.s.evidenceAssessments ?? []).filter(
      (a) => INVALIDATING.has(a.finding) && primaryIds.has(a.evidenceId),
    );
    return bad.length === 0
      ? { status: 'PASS', reasons: [Reason.NO_INVALIDATING_ASSESSMENT] }
      : {
          status: 'FAIL',
          reasons: [Reason.INVALIDATING_ASSESSMENT],
          supportingEvidenceIds: uniq(bad.map((a) => a.evidenceId)),
        };
  }

  /**
   * BRT-01 V2: RESULT_OFFICIAL (path A) OR RESULT_ACCURATE + a T5 record (path B), by a principal
   * exercising DECLARE_OFFICIAL or ATTEST_RESULT through a valid, scoped, non-conflicted chain.
   * Never simplified to "RESULT_ACCURATE + ATTEST_RESULT". A path whose canonical producer does not
   * exist is INPUT_NOT_SUPPORTED (never assumed).
   */
  officialDeclaration(
    capabilities: readonly Capability[] = OFFICIAL_DECLARATION_CAPABILITIES,
  ): OfficialDeclaration {
    const key = [...capabilities].sort().join(',');
    const memo = this.officialMemo.get(key);
    if (memo !== undefined) return memo;
    const reasons: string[] = [];
    const authority: TraceDecision[] = [];
    let unsupported = false;
    let result: OfficialDeclaration | undefined;

    // Path A — RESULT_OFFICIAL attestation.
    if (!this.ctx.supports('RESULT_OFFICIAL_ATTESTATION')) {
      unsupported = true;
      reasons.push(notSupported('RESULT_OFFICIAL_ATTESTATION'));
    } else {
      for (const f of this.resultClaims('AFFIRM', 'RESULT_OFFICIAL')) {
        const r = this.ctx.authorizeAny(subjectOf(f), capabilities);
        authority.push(...(r.authorized === undefined ? r.attempts : [r.authorized]));
        if (r.authorized !== undefined) {
          result = {
            status: 'PASS',
            reasons: [Reason.OFFICIAL_DECLARATION_AUTHORIZED],
            supporting: [f.attestationId],
            authority: [r.authorized],
            certifying: [{ subject: subjectOf(f), capability: r.authorized.capability }],
          };
          break;
        }
      }
    }

    // Path B — RESULT_ACCURATE by the same kind of authority + a T5 (PROVISIONAL → OFFICIAL) record.
    if (result === undefined) {
      const accurate: { fact: SnapshotAttestation; decision: TraceDecision }[] = [];
      for (const f of this.resultClaims('AFFIRM', 'RESULT_ACCURATE')) {
        const r = this.ctx.authorizeAny(subjectOf(f), capabilities);
        if (r.authorized !== undefined) accurate.push({ fact: f, decision: r.authorized });
        else if (this.ctx.sidesOf(f.issuerPrincipalId).size === 0) authority.push(...r.attempts);
      }
      if (accurate.length > 0) {
        reasons.push(Reason.AUTHORIZED_RESULT_ACCURATE_PRESENT);
        authority.push(...accurate.map((a) => a.decision));
      }
      if (!this.ctx.supports('T5_OFFICIAL_TRANSITION')) {
        unsupported = true;
        reasons.push(notSupported('T5_OFFICIAL_TRANSITION'));
      } else if (accurate.length > 0) {
        for (const t of [...(this.s.t5Transitions ?? [])].sort((a, b) =>
          a.transitionId < b.transitionId ? -1 : 1,
        )) {
          const subject: AuthoritySubject = {
            principalId: t.actorPrincipalId,
            atTime: t.recordedAt,
            factId: t.transitionId,
          };
          const r = this.ctx.authorizeAny(subject, ['DECLARE_OFFICIAL']);
          authority.push(...(r.authorized === undefined ? r.attempts : [r.authorized]));
          if (r.authorized !== undefined) {
            const first = accurate[0] as { fact: SnapshotAttestation; decision: TraceDecision };
            result = {
              status: 'PASS',
              reasons: [
                Reason.T5_DECLARATION_AUTHORIZED,
                Reason.AUTHORIZED_RESULT_ACCURATE_PRESENT,
              ],
              supporting: [first.fact.attestationId],
              authority: [first.decision, r.authorized],
              certifying: [{ subject, capability: 'DECLARE_OFFICIAL' }],
            };
            break;
          }
        }
      }
    }
    const out: OfficialDeclaration =
      result ??
      ({
        status: unsupported
          ? 'INPUT_NOT_SUPPORTED'
          : EvaluationContext.conflictUnknown(authority)
            ? 'UNKNOWN'
            : 'FAIL',
        reasons: uniq([...reasons, Reason.NO_AUTHORIZED_DECLARATION]),
        supporting: [],
        authority,
        certifying: [],
      } satisfies OfficialDeclaration);
    this.officialMemo.set(key, out);
    return out;
  }

  officialDeclarationCriterion(c: PolicyCriterion): Partial_ {
    const r = this.officialDeclaration(param(c, 'capabilities', OFFICIAL_DECLARATION_CAPABILITIES));
    return {
      status: r.status,
      reasons: r.reasons,
      supportingAttestationIds: r.supporting,
      authority: r.authority,
    };
  }

  /** BRT-01 §5.3 / V2: no ACTIVE DENY by an authorized, non-conflicted result authority. */
  noAuthorizedDeny(): Partial_ {
    const authority: TraceDecision[] = [];
    const bad: string[] = [];
    let unknown = false;
    for (const f of this.activeDenies()) {
      if (this.ctx.sidesOf(f.issuerPrincipalId).size > 0) continue; // a participant is never an authority here (A-5)
      const r = this.ctx.authorizeAny(subjectOf(f), OFFICIAL_DECLARATION_CAPABILITIES);
      authority.push(...(r.authorized === undefined ? r.attempts : [r.authorized]));
      if (r.authorized !== undefined) bad.push(f.attestationId);
      else if (EvaluationContext.conflictUnknown(r.attempts)) unknown = true;
    }
    if (bad.length > 0)
      return {
        status: 'FAIL',
        reasons: [Reason.AUTHORIZED_DENY],
        supportingAttestationIds: bad,
        authority,
      };
    if (unknown) return { status: 'UNKNOWN', reasons: [Reason.DENY_AUTHORITY_UNKNOWN], authority };
    return { status: 'PASS', reasons: [Reason.NO_AUTHORIZED_DENY], authority };
  }

  // ───────────────────────────── V3 ─────────────────────────────

  /**
   * BRT-01 V3: COMPETITION_SANCTIONED for this competition/event by a principal exercising SANCTION
   * through an anchor recognized at ≥ minRecognitionLevel (never PLATFORM) covering sport, region
   * and event. Organization type never substitutes for this.
   */
  competitionSanctioned(
    c: PolicyCriterion,
  ): Partial_ & { anchors: { anchorId: string; level: RecognitionLevel }[] } {
    if (this.sanctionMemo !== undefined) return this.sanctionMemo;
    const min = param(c, 'minRecognitionLevel', 'REGIONAL');
    const minRank = recognitionRank(min) ?? Number.MAX_SAFE_INTEGER;
    if (!this.ctx.supports('COMPETITION_SANCTIONED_ATTESTATION'))
      return (this.sanctionMemo = {
        status: 'INPUT_NOT_SUPPORTED',
        reasons: [notSupported('COMPETITION_SANCTIONED_ATTESTATION')],
        anchors: [],
      });
    const h = this.s.hierarchy;
    const relevant = (this.s.sanctions ?? []).filter(
      (f) =>
        this.ctx.counts(f) &&
        ((f.subjectLevel === 'COMPETITION' && f.subjectId === h.competitionId) ||
          (f.subjectLevel === 'EVENT' && f.subjectId === h.eventId)),
    );
    const authority: TraceDecision[] = [];
    const reasons: string[] = [];
    const anchors: { anchorId: string; level: RecognitionLevel }[] = [];
    const supporting: string[] = [];
    let denied = false;
    for (const f of relevant) {
      const rank = recognitionRank(f.recognitionLevel);
      if (rank === undefined) {
        reasons.push(Reason.RECOGNITION_PLATFORM_CEILING);
        continue;
      }
      if (rank < minRank) {
        reasons.push(Reason.RECOGNITION_TOO_LOW);
        continue;
      }
      const d = this.ctx.authorizeOnce(subjectOf(f), 'SANCTION', f.recognitionLevel);
      authority.push(d);
      if (!d.authorized) continue;
      if (f.polarity === 'DENY') denied = true;
      else if (d.anchorId !== undefined) {
        anchors.push({ anchorId: d.anchorId, level: f.recognitionLevel });
        supporting.push(f.attestationId);
      }
    }
    const status: CriterionStatus = denied
      ? 'FAIL'
      : anchors.length > 0
        ? 'PASS'
        : EvaluationContext.conflictUnknown(authority)
          ? 'UNKNOWN'
          : 'FAIL';
    return (this.sanctionMemo = {
      status,
      reasons: uniq(
        denied
          ? [Reason.SANCTION_DENIED]
          : anchors.length > 0
            ? [Reason.SANCTION_AUTHORIZED]
            : [...reasons, Reason.NO_AUTHORIZED_SANCTION],
      ),
      supportingAttestationIds: supporting,
      authority,
      anchors,
    });
  }

  /**
   * BRT-01 V3: the certifying chain roots in the sanctioning anchor, or in an anchor with equal or
   * higher (non-platform) recognition for the sport and region (the request scope carries them).
   */
  certificationRootedInSanction(
    sanction: PolicyCriterion | undefined,
    v2Capabilities: readonly Capability[],
  ): Partial_ {
    const s = this.competitionSanctioned(
      sanction ?? { id: 'implicit', kind: 'COMPETITION_SANCTIONED' },
    );
    const o = this.officialDeclaration(v2Capabilities);
    if (s.status === 'INPUT_NOT_SUPPORTED' || o.status === 'INPUT_NOT_SUPPORTED')
      return {
        status: 'INPUT_NOT_SUPPORTED',
        reasons: uniq([
          ...s.reasons.filter((r) => r.startsWith('NOT_SUPPORTED_')),
          ...o.reasons.filter((r) => r.startsWith('NOT_SUPPORTED_')),
        ]),
      };
    if (s.status !== 'PASS' || o.status !== 'PASS')
      return {
        status: s.status === 'UNKNOWN' || o.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAIL',
        reasons: [Reason.PREREQUISITE_NOT_MET],
      };
    const authority: TraceDecision[] = [];
    for (const { anchorId, level } of s.anchors) {
      for (const cert of o.certifying) {
        const r = this.ctx.authorizeAny(cert.subject, [cert.capability], levelsAtOrAbove(level));
        authority.push(...(r.authorized === undefined ? r.attempts : [r.authorized]));
        if (r.authorized !== undefined)
          return {
            status: 'PASS',
            reasons: [Reason.CERTIFICATION_ROOTED],
            authority: [r.authorized],
            supportingAttestationIds: [cert.subject.factId ?? ''].filter((x) => x !== ''),
          };
        const same = this.ctx.authorizeAny(
          cert.subject,
          [cert.capability],
          ALL_RECOGNITION_LEVELS,
        ).authorized;
        if (same !== undefined && same.anchorId === anchorId)
          return { status: 'PASS', reasons: [Reason.CERTIFICATION_ROOTED], authority: [same] };
      }
    }
    return { status: 'FAIL', reasons: [Reason.CERTIFICATION_NOT_ROOTED], authority };
  }

  /** BRT-01 V3: the discipline's full official evidence set is linked (future producer). */
  officialEvidenceSet(): Partial_ {
    if (!this.ctx.supports('OFFICIAL_EVIDENCE_SET'))
      return { status: 'INPUT_NOT_SUPPORTED', reasons: [notSupported('OFFICIAL_EVIDENCE_SET')] };
    const set = this.s.officialEvidenceSet;
    if (set === undefined)
      return { status: 'FAIL', reasons: [Reason.OFFICIAL_EVIDENCE_SET_UNDECLARED] };
    const invalid = new Set(
      (this.s.evidenceAssessments ?? [])
        .filter((a) => INVALIDATING.has(a.finding))
        .map((a) => a.evidenceId),
    );
    const present = (this.s.evidence ?? []).filter(
      (e) =>
        (e.versionRoles ?? []).some((r) => r === 'PRIMARY' || r === 'SUPPORTING') &&
        (e.availability === 'AVAILABLE' || e.availability === 'ARCHIVED') &&
        !invalid.has(e.evidenceId),
    );
    const covered = set.evidenceTypes.filter((t) => present.some((e) => e.evidenceType === t));
    return {
      status: covered.length === set.evidenceTypes.length ? 'PASS' : 'FAIL',
      reasons: [
        covered.length === set.evidenceTypes.length
          ? Reason.OFFICIAL_EVIDENCE_SET_COMPLETE
          : Reason.OFFICIAL_EVIDENCE_TYPE_MISSING,
      ],
      observed: covered.length,
      required: set.evidenceTypes.length,
      supportingEvidenceIds: present
        .filter((e) => covered.includes(e.evidenceType))
        .map((e) => e.evidenceId),
    };
  }

  /** BRT-01 V3: IDENTITY_CONFIRMED (ATTEST_IDENTITY) for every athlete the version credits. */
  identityConfirmed(): Partial_ {
    if (!this.ctx.supports('IDENTITY_CONFIRMED_ATTESTATION'))
      return {
        status: 'INPUT_NOT_SUPPORTED',
        reasons: [notSupported('IDENTITY_CONFIRMED_ATTESTATION')],
      };
    const sides = this.s.participation.sides ?? [];
    const entryIds = this.s.resultVersion.entryParticipantIds ?? sides.map((x) => x.participantId);
    const missingSide = entryIds.some((id) => !sides.some((x) => x.participantId === id));
    if (!this.s.participation.sidesComplete || missingSide)
      return { status: 'UNKNOWN', reasons: [Reason.PARTICIPATION_UNKNOWN] };
    const athletes = uniq(
      sides.filter((x) => entryIds.includes(x.participantId)).flatMap((x) => x.athleteIds ?? []),
    );
    const authority: TraceDecision[] = [];
    const supporting: string[] = [];
    let confirmed = 0;
    for (const athleteId of athletes) {
      const facts = (this.s.identityConfirmations ?? []).filter(
        (f) => f.athleteId === athleteId && f.polarity === 'AFFIRM' && this.ctx.counts(f),
      );
      for (const f of facts) {
        const r = this.ctx.authorizeAny(subjectOf(f), ['ATTEST_IDENTITY']);
        authority.push(...(r.authorized === undefined ? r.attempts : [r.authorized]));
        if (r.authorized !== undefined) {
          confirmed += 1;
          supporting.push(f.attestationId);
          break;
        }
      }
    }
    return {
      status: athletes.length > 0 && confirmed === athletes.length ? 'PASS' : 'FAIL',
      reasons: [
        athletes.length > 0 && confirmed === athletes.length
          ? Reason.IDENTITY_CONFIRMED
          : Reason.IDENTITY_NOT_CONFIRMED,
      ],
      observed: confirmed,
      required: athletes.length,
      supportingAttestationIds: supporting,
      authority,
    };
  }

  // ───────────────────────────── V4 ─────────────────────────────

  /** BRT-01 V4: CONDITIONS_COMPLIANT by ATTEST_CONDITIONS covering the record category's conditions. */
  conditionsCompliant(): Partial_ {
    if (!this.ctx.supports('CONDITIONS_COMPLIANT_ATTESTATION'))
      return {
        status: 'INPUT_NOT_SUPPORTED',
        reasons: [notSupported('CONDITIONS_COMPLIANT_ATTESTATION')],
      };
    const authority: TraceDecision[] = [];
    const affirmed: SnapshotAttestation[] = [];
    let denied = false;
    for (const f of (this.s.attestations ?? []).filter(
      (a) => a.claimType === 'CONDITIONS_COMPLIANT' && this.ctx.counts(a),
    )) {
      if (this.ctx.sidesOf(f.issuerPrincipalId).size > 0) continue;
      const r = this.ctx.authorizeAny(subjectOf(f), ['ATTEST_CONDITIONS']);
      authority.push(...(r.authorized === undefined ? r.attempts : [r.authorized]));
      if (r.authorized === undefined) continue;
      if (f.polarity === 'DENY') denied = true;
      else affirmed.push(f);
    }
    if (!this.ctx.supports('RECORD_CATEGORY'))
      return {
        status: 'INPUT_NOT_SUPPORTED',
        reasons: [
          notSupported('RECORD_CATEGORY'),
          ...(affirmed.length > 0 ? [Reason.CONDITIONS_AUTHORIZED] : []),
        ],
        supportingAttestationIds: affirmed.map((a) => a.attestationId),
        authority,
      };
    const category = this.s.recordCategory;
    if (category === undefined)
      return { status: 'FAIL', reasons: [Reason.RECORD_CATEGORY_UNDECLARED], authority };
    if (denied) return { status: 'FAIL', reasons: [Reason.CONDITIONS_DENIED], authority };
    const aspects = new Set(affirmed.flatMap((a) => a.conditionAspects ?? []));
    const required = category.requiredConditionAspects ?? [];
    const missing = required.filter((a) => !aspects.has(a));
    const ok = affirmed.length > 0 && missing.length === 0;
    return {
      status: ok ? 'PASS' : 'FAIL',
      reasons: [ok ? Reason.CONDITIONS_AUTHORIZED : Reason.CONDITION_ASPECT_MISSING],
      observed: required.length - missing.length,
      required: required.length,
      supportingAttestationIds: affirmed.map((a) => a.attestationId),
      authority,
    };
  }

  /**
   * BRT-01 V4: ≥ N INDEPENDENT primary sources. Provenance, not bytes or item ids: derived /
   * redacted / transformed copies collapse to their lineage root; a root's stable source Principal
   * is the source identity (principals on one participant side collapse to that side); unknown
   * provenance and generic machine derivation never add an independent source.
   */
  independentPrimarySources(c: PolicyCriterion): Partial_ {
    const min = param(c, 'minSources', 2);
    const p = this.primary();
    const byId = new Map((this.s.evidence ?? []).map((e) => [e.evidenceId, e]));
    const groups = new Map<string, { ids: string[]; classification: string }>();
    const add = (key: string, id: string, classification: string) => {
      const g = groups.get(key) ?? { ids: [], classification };
      g.ids.push(id);
      groups.set(key, g);
    };
    for (const e of p.counted) {
      const root = byId.get(e.provenanceRootId);
      if (root === undefined || root.sourcePrincipalId === undefined) {
        add(`UNKNOWN_PROVENANCE:${e.provenanceRootId}`, e.evidenceId, Reason.UNKNOWN_PROVENANCE);
        continue;
      }
      if (isGenericMachineDerived(e) || isGenericMachineDerived(root)) {
        add(
          `GENERIC_MACHINE_DERIVED:${e.provenanceRootId}`,
          e.evidenceId,
          Reason.GENERIC_MACHINE_DERIVED,
        );
        continue;
      }
      const pid = root.sourcePrincipalId;
      if (this.ctx.participation(pid)?.resolution !== 'RESOLVED') {
        add(`UNKNOWN_PROVENANCE:${pid}`, e.evidenceId, Reason.PARTICIPATION_UNKNOWN);
        continue;
      }
      const sides = [...this.ctx.sidesOf(pid)].sort();
      add(
        sides.length > 0 ? `SIDE:${sides[0]}` : `PRINCIPAL:${pid}`,
        e.evidenceId,
        Reason.INDEPENDENT_SOURCE,
      );
    }
    const sourceGroups = [...groups.entries()].map(([groupKey, g]) => ({
      groupKey,
      evidenceIds: g.ids,
      classification: g.classification,
    }));
    const independent = sourceGroups.filter(
      (g) => g.classification === Reason.INDEPENDENT_SOURCE,
    ).length;
    return {
      status: independent >= min ? 'PASS' : 'FAIL',
      reasons: [independent >= min ? Reason.MINIMUM_MET : Reason.BELOW_MINIMUM],
      observed: independent,
      required: min,
      supportingEvidenceIds: sourceGroups
        .filter((g) => g.classification === Reason.INDEPENDENT_SOURCE)
        .flatMap((g) => g.evidenceIds),
      sourceGroups,
    };
  }

  /** BRT-01 V4: every signature counted toward V1–V4 is HOLDER_KEY or DEVICE_KEY. */
  nonWitnessedSignatures(countedIds: ReadonlySet<string>): Partial_ {
    const witnessed = this.allSignedFacts().filter(
      (f) => countedIds.has(f.attestationId) && f.assurance === 'PLATFORM_WITNESSED',
    );
    return witnessed.length === 0
      ? {
          status: 'PASS',
          reasons: [Reason.ALL_SIGNATURES_NON_WITNESSED],
          observed: countedIds.size,
        }
      : {
          status: 'FAIL',
          reasons: [Reason.PLATFORM_WITNESSED_SIGNATURE],
          supportingAttestationIds: witnessed.map((f) => f.attestationId),
        };
  }

  /**
   * BRT-01 V4: RECORD_RATIFIED or REVIEW_COMPLETED for the record category by a HUMAN principal
   * exercising RATIFY_RECORD at the category's recognition level (a PLATFORM review panel can only
   * ratify PLATFORM-scope categories — enforced by the anchor recognition rules). Never a generic
   * "Result ratification": without a record category there is nothing to ratify.
   */
  recordRatified(): Partial_ {
    if (!this.ctx.supports('RECORD_CATEGORY'))
      return { status: 'INPUT_NOT_SUPPORTED', reasons: [notSupported('RECORD_CATEGORY')] };
    if (
      !this.ctx.supports('RECORD_RATIFIED_ATTESTATION') &&
      !this.ctx.supports('REVIEW_COMPLETED_ATTESTATION')
    )
      return {
        status: 'INPUT_NOT_SUPPORTED',
        reasons: [
          notSupported('RECORD_RATIFIED_ATTESTATION'),
          notSupported('REVIEW_COMPLETED_ATTESTATION'),
        ],
      };
    const category = this.s.recordCategory;
    if (category === undefined)
      return { status: 'FAIL', reasons: [Reason.RECORD_CATEGORY_UNDECLARED] };
    const authority: TraceDecision[] = [];
    const reasons: string[] = [];
    for (const f of (this.s.ratifications ?? []).filter(
      (r) =>
        r.polarity === 'AFFIRM' &&
        r.recordCategoryId === category.recordCategoryId &&
        this.ctx.counts(r) &&
        this.ctx.supports(
          r.kind === 'RECORD_RATIFIED'
            ? 'RECORD_RATIFIED_ATTESTATION'
            : 'REVIEW_COMPLETED_ATTESTATION',
        ),
    )) {
      if (f.issuerPrincipalType !== 'PERSON' && f.issuerPrincipalType !== 'ORGANIZATION') {
        reasons.push(Reason.RATIFIER_NOT_HUMAN);
        continue;
      }
      const d = this.ctx.authorizeOnce(subjectOf(f), 'RATIFY_RECORD', category.recognitionLevel);
      authority.push(d);
      if (d.authorized)
        return {
          status: 'PASS',
          reasons: [Reason.RATIFICATION_AUTHORIZED],
          supportingAttestationIds: [f.attestationId],
          authority,
        };
    }
    return {
      status: EvaluationContext.conflictUnknown(authority) ? 'UNKNOWN' : 'FAIL',
      reasons: uniq([...reasons, Reason.NO_AUTHORIZED_RATIFICATION]),
      authority,
    };
  }

  // ───────────────────────────── structural ─────────────────────────────

  /**
   * BRT-01 R-6: a classification is never more verified than its weakest input (≥ V1). The
   * snapshot carries no derived-input levels (no producer: BRT-03 content has no derivedFrom), so a
   * classification can never pass V1+ today.
   */
  derivedInputs(): Partial_ {
    if (this.s.resultVersion.scopeType === 'CONTEST')
      return { status: 'NOT_APPLICABLE', reasons: [Reason.NOT_A_CLASSIFICATION] };
    return {
      status: 'INPUT_NOT_SUPPORTED',
      reasons: [notSupported('DERIVED_INPUT_LEVELS'), Reason.DERIVED_INPUTS_REQUIRED],
    };
  }
}
