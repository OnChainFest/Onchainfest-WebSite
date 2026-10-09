import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  VERIFICATION_LEVELS,
  type Capability,
  type CriterionStatus,
  type EvaluationState,
  type VerificationFlag,
  type VerificationLevel,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { EvaluationContext, type TraceDecision } from './context';
import { Criteria, type CriterionResult } from './criteria';
import {
  ENGINE_ID,
  ENGINE_VERSION,
  OFFICIAL_DECLARATION_CAPABILITIES,
  param,
  validatePolicySpec,
  type PolicyCriterion,
} from './policy';
import { canonicalizeSnapshot, type VerificationSnapshot } from './snapshot';

/**
 * The pure, deterministic Sports Oracle (BRT-07 §27):
 *
 *   evaluateVerification(snapshot) → { outcome, outcomeHash, trace, traceHash }
 *
 * No database, network, filesystem, clock, randomness or environment access: every fact is in the
 * snapshot. Levels are evaluated bottom-up; a level is SATISFIED only if every one of its criteria
 * PASSES and the level below is satisfied in the same evaluation (V3 never without V2, V4 never
 * without V3). UNKNOWN, INSUFFICIENT and INPUT_NOT_SUPPORTED never pass. There is no score,
 * confidence, probability or weight anywhere.
 *
 * Changing ANY evaluation semantics requires a new ENGINE_VERSION (verification-engine/2); persisted
 * runs keep the version, outcome and trace documents they were produced with.
 */
export type LevelStatus = 'SATISFIED' | 'BLOCKED' | 'NOT_REACHED' | 'NOT_DEFINED';

export interface OutcomeCriterion {
  readonly criterionId: string;
  readonly kind: string;
  readonly status: CriterionStatus;
  readonly reasons?: readonly string[];
}

export interface VerificationOutcome {
  readonly engineId: string;
  readonly engineVersion: string;
  readonly evaluationState: Extract<EvaluationState, 'EVALUATED' | 'INSUFFICIENT_INPUT'>;
  readonly resultVersionId: string;
  readonly policyVersionId: string;
  readonly policySpecHash: string;
  readonly snapshotHash: string;
  readonly highestSatisfiedLevel?: VerificationLevel;
  readonly satisfiedLevels?: readonly VerificationLevel[];
  readonly levels: readonly {
    readonly level: VerificationLevel;
    readonly status: LevelStatus;
    readonly criteria?: readonly OutcomeCriterion[];
  }[];
  readonly flags?: readonly VerificationFlag[];
  readonly traceHash: string;
}

export interface VerificationTrace {
  readonly engineVersion: string;
  readonly snapshotHash: string;
  readonly signedFacts?: readonly {
    readonly attestationId: string;
    readonly factType: 'ATTESTATION' | 'SANCTION' | 'IDENTITY_CONFIRMATION' | 'RATIFICATION';
    readonly status: 'ACTIVE' | 'RETRACTED' | 'SUPERSEDED';
    readonly keyTrust: 'TRUSTED' | 'SUSPECT' | 'INVALID';
    readonly keyReason?: string;
    readonly counts: boolean;
  }[];
  readonly criteria: readonly TraceCriterion[];
}

export type TraceCriterion = Omit<CriterionResult, 'authority'> & {
  readonly grantIds?: readonly string[];
  readonly anchorIds?: readonly string[];
  readonly authority?: readonly TraceDecision[];
};

export interface VerificationEvaluation {
  readonly snapshotHash: ContentHash;
  readonly outcome: VerificationOutcome;
  readonly outcomeHash: ContentHash;
  readonly trace: VerificationTrace;
  readonly traceHash: ContentHash;
}

/** Keeps only the trace members of a criterion result (evaluators may carry private helpers). */
function traceable(r: Omit<CriterionResult, 'criterionId' | 'kind' | 'level'>) {
  const {
    status,
    reasons,
    observed,
    required,
    supportingAttestationIds,
    supportingEvidenceIds,
    authority,
    issuerGroups,
    sourceGroups,
    participation,
  } = r;
  return Object.fromEntries(
    Object.entries({
      status,
      reasons,
      observed,
      required,
      supportingAttestationIds,
      supportingEvidenceIds,
      authority,
      issuerGroups,
      sourceGroups,
      participation,
    }).filter(([, v]) => v !== undefined),
  ) as Omit<CriterionResult, 'criterionId' | 'kind' | 'level'>;
}

const integrity = (message: string, reason: string) =>
  new DomainError(DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE, message, { reason });

const dedupe = <T>(xs: readonly T[]): T[] => {
  const seen = new Map<string, T>();
  for (const x of xs)
    seen.set(typeof x === 'string' ? x : JSON.stringify(x, Object.keys(x as object).sort()), x);
  return [...seen.values()];
};

function hashDoc(tag: string, schema: { id: string; version: number }, doc: unknown) {
  try {
    return platformCanonicalizer().hashCanonical(tag, schema.id, schema.version, doc);
  } catch (err) {
    if (err instanceof CanonicalError)
      throw integrity(
        `${schema.id} document rejected: ${err.code} at ${err.path || '/'}`,
        'DOCUMENT_NOT_CANONICAL',
      );
    throw err;
  }
}

/**
 * Evaluates a snapshot. The snapshot is re-canonicalized first (closed schema, sets sorted): any
 * non-canonical input or a policy spec that does not match its recorded hash is an INTEGRITY
 * failure (a thrown system error), never an ordinary criterion failure.
 */
export function evaluateVerification(input: VerificationSnapshot): VerificationEvaluation {
  const { snapshot, snapshotHash } = canonicalizeSnapshot(input);
  const policy = validatePolicySpec(snapshot.policy.spec);
  if (!policy.ok) throw integrity('snapshot policy spec is not a valid policy', 'POLICY_INVALID');
  if (policy.specHash !== snapshot.policy.specHash)
    throw integrity('snapshot policy spec does not match its hash', 'POLICY_HASH_MISMATCH');
  if (policy.spec.targetEngine !== ENGINE_VERSION)
    throw integrity('policy targets another engine version', 'ENGINE_VERSION_MISMATCH');

  const spec = policy.spec;
  const find = (kind: string) =>
    spec.levels.flatMap((l) => l.criteria).find((c) => c.kind === kind) as
      PolicyCriterion | undefined;
  const officialCriterion = find('OFFICIAL_DECLARATION');
  const v2Capabilities: readonly Capability[] =
    officialCriterion === undefined
      ? OFFICIAL_DECLARATION_CAPABILITIES
      : param(officialCriterion, 'capabilities', OFFICIAL_DECLARATION_CAPABILITIES);
  const ctx = new EvaluationContext(snapshot);
  const cr = new Criteria(ctx, find('PRIMARY_EVIDENCE'));

  const evaluate = (c: PolicyCriterion) => {
    switch (c.kind) {
      case 'CLAIM_BOUND':
        return cr.claimBound();
      case 'INDEPENDENT_CORROBORATION':
        return cr.independentCorroboration(c);
      case 'NO_COUNTERPARTY_DENY':
        return cr.noCounterpartyDeny(v2Capabilities);
      case 'NO_ACTIVE_DISPUTE':
        return cr.noActiveDispute();
      case 'PRIMARY_EVIDENCE':
        return cr.primaryEvidence(c);
      case 'PRIMARY_EVIDENCE_INTEGRITY':
        return cr.primaryEvidenceIntegrity();
      case 'NO_INVALIDATING_ASSESSMENT':
        return cr.noInvalidatingAssessment();
      case 'OFFICIAL_DECLARATION':
        return cr.officialDeclarationCriterion(c);
      case 'NO_AUTHORIZED_DENY':
        return cr.noAuthorizedDeny();
      case 'COMPETITION_SANCTIONED':
        return cr.competitionSanctioned(c);
      case 'CERTIFICATION_ROOTED_IN_SANCTION':
        return cr.certificationRootedInSanction(find('COMPETITION_SANCTIONED'), v2Capabilities);
      case 'OFFICIAL_EVIDENCE_SET':
        return cr.officialEvidenceSet();
      case 'IDENTITY_CONFIRMED':
        return cr.identityConfirmed();
      case 'CONDITIONS_COMPLIANT':
        return cr.conditionsCompliant();
      case 'INDEPENDENT_PRIMARY_SOURCES':
        return cr.independentPrimarySources(c);
      case 'RECORD_RATIFIED':
        return cr.recordRatified();
      case 'NON_WITNESSED_SIGNATURES':
        return undefined; // needs the other criteria first (below)
    }
  };

  const results = new Map<string, CriterionResult>();
  const deferred: { c: PolicyCriterion; level: VerificationLevel }[] = [];
  for (const lvl of spec.levels) {
    for (const c of lvl.criteria) {
      const r = evaluate(c);
      if (r === undefined) deferred.push({ c, level: lvl.level });
      else
        results.set(c.id, { ...traceable(r), criterionId: c.id, kind: c.kind, level: lvl.level });
    }
    if (lvl.level !== 'V0' && snapshot.resultVersion.scopeType !== 'CONTEST') {
      const id = `structural.${lvl.level.toLowerCase()}.derived-inputs`;
      results.set(id, {
        ...cr.derivedInputs(),
        criterionId: id,
        kind: 'DERIVED_INPUT_LEVELS',
        level: lvl.level,
      });
    }
  }
  // Signatures counted toward V1–V4 (supporting facts of passing criteria) must be non-witnessed.
  const counted = new Set(
    [...results.values()]
      .filter((r) => r.level !== 'V0' && r.status === 'PASS')
      .flatMap((r) => r.supportingAttestationIds ?? []),
  );
  for (const { c, level } of deferred)
    results.set(c.id, {
      ...cr.nonWitnessedSignatures(counted),
      criterionId: c.id,
      kind: c.kind,
      level,
    });

  // Level assembly: cumulative, bottom-up.
  let previousSatisfied = true;
  const satisfied: VerificationLevel[] = [];
  const levels = VERIFICATION_LEVELS.map((level) => {
    const def = spec.levels.find((l) => l.level === level);
    if (def === undefined) {
      previousSatisfied = false;
      return { level, status: 'NOT_DEFINED' as LevelStatus };
    }
    const mine = [...results.values()].filter((r) => r.level === level);
    const pass = mine.every((r) => r.status === 'PASS');
    const status: LevelStatus = !previousSatisfied ? 'NOT_REACHED' : pass ? 'SATISFIED' : 'BLOCKED';
    if (status === 'SATISFIED') satisfied.push(level);
    else previousSatisfied = false;
    return {
      level,
      status,
      criteria: mine.map((r) => ({
        criterionId: r.criterionId,
        kind: r.kind,
        status: r.status,
        reasons: dedupe(r.reasons),
      })),
    };
  });

  const signedFacts = [
    ...(snapshot.attestations ?? []).map((f) => ({ f, factType: 'ATTESTATION' as const })),
    ...(snapshot.sanctions ?? []).map((f) => ({ f, factType: 'SANCTION' as const })),
    ...(snapshot.identityConfirmations ?? []).map((f) => ({
      f,
      factType: 'IDENTITY_CONFIRMATION' as const,
    })),
    ...(snapshot.ratifications ?? []).map((f) => ({ f, factType: 'RATIFICATION' as const })),
  ].map(({ f, factType }) => {
    const k = ctx.keyTrust(f);
    return {
      attestationId: f.attestationId,
      factType,
      status: f.status,
      keyTrust: k.trust,
      ...(k.trust === 'TRUSTED' ? {} : { keyReason: k.reason }),
      counts: f.status === 'ACTIVE' && k.trust === 'TRUSTED',
    };
  });

  const trace: VerificationTrace = {
    engineVersion: ENGINE_VERSION,
    snapshotHash,
    signedFacts,
    criteria: [...results.values()].map((r): TraceCriterion => {
      const authority = r.authority === undefined ? undefined : dedupe(r.authority);
      return {
        ...r,
        reasons: dedupe(r.reasons),
        ...(r.supportingAttestationIds === undefined
          ? {}
          : { supportingAttestationIds: dedupe(r.supportingAttestationIds) }),
        ...(r.supportingEvidenceIds === undefined
          ? {}
          : { supportingEvidenceIds: dedupe(r.supportingEvidenceIds) }),
        ...(authority === undefined
          ? {}
          : {
              authority,
              grantIds: dedupe(authority.flatMap((a) => a.grantChain)),
              anchorIds: dedupe(
                authority.flatMap((a) => (a.anchorId === undefined ? [] : [a.anchorId])),
              ),
            }),
        ...(r.participation === undefined ? {} : { participation: dedupe(r.participation) }),
      };
    }),
  };
  const t = hashDoc(DomainTag.verificationTrace, SchemaRef.verificationTrace, trace);

  const v0 = levels[0]?.status === 'SATISFIED';
  const highest = satisfied[satisfied.length - 1];
  const outcome: VerificationOutcome = {
    engineId: ENGINE_ID,
    engineVersion: ENGINE_VERSION,
    evaluationState: v0 ? 'EVALUATED' : 'INSUFFICIENT_INPUT',
    resultVersionId: snapshot.resultVersion.resultVersionId,
    policyVersionId: snapshot.policy.policyVersionId,
    policySpecHash: snapshot.policy.specHash,
    snapshotHash,
    ...(highest === undefined ? {} : { highestSatisfiedLevel: highest }),
    satisfiedLevels: satisfied,
    levels,
    flags: [...cr.flags].sort(),
    traceHash: t.contentHash,
  };
  const o = hashDoc(DomainTag.verificationOutcome, SchemaRef.verificationOutcome, outcome);
  return {
    snapshotHash,
    outcome: o.normalized as unknown as VerificationOutcome,
    outcomeHash: o.contentHash,
    trace: t.normalized as unknown as VerificationTrace,
    traceHash: t.contentHash,
  };
}

/** Re-hashes a stored outcome / trace document (persisted-run integrity checks). */
export function hashOutcome(outcome: unknown): ContentHash {
  return hashDoc(DomainTag.verificationOutcome, SchemaRef.verificationOutcome, outcome).contentHash;
}
export function hashTrace(trace: unknown): ContentHash {
  return hashDoc(DomainTag.verificationTrace, SchemaRef.verificationTrace, trace).contentHash;
}
