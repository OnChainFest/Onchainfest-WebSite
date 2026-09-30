import {
  authorize,
  type AnchorFact,
  type AuthorityFacts,
  type AuthorizationDecision,
  type ConflictOfInterestChecker,
  type KeyFact,
} from '@br/authority';
import { pathToScope } from '@br/competition';
import {
  RecognitionLevel,
  STRUCTURAL_CONFLICT_RELATIONS,
  type AuthorityGrant,
  type AuthorityScope,
  type CanonicalFactKind,
  type Capability,
  type GrantStatusChange,
  type KeyStatusChange,
  type ParticipationRelation,
  type Principal,
  type TrustAnchorStatusChange,
  type Uuid,
} from '@br/domain';
import { Reason } from './reasons';
import type { SignedFact, VerificationSnapshot } from './snapshot';

/**
 * Per-evaluation context: indexes over ONE snapshot, and the three separate trust judgements the
 * criteria need — kept apart on purpose:
 *
 *   signature validity  re-verified by the assembler (snapshot `proof: VERIFIED`)
 *   key trust           keyTrust(): key ownership, validity at issuedAt, revocation / compromise
 *                       facts known at the cutoff (signedAt can only restrict)
 *   sporting authority  authorize(): the BRT-03 chain evaluation at the fact's effective time
 *
 * Nothing here reads a clock, the environment, randomness or any store: the snapshot is the whole
 * world. The authority knowledge horizon is "every fact in the snapshot" (the assembler already
 * applied the real cutoff), expressed as a fixed constant so proofs stay deterministic.
 */
const KNOWLEDGE_HORIZON = new Date('9999-12-31T23:59:59.999Z');
const RECOGNITION_ORDER: readonly RecognitionLevel[] = [
  'CLUB',
  'REGIONAL',
  'NATIONAL',
  'CONTINENTAL',
  'WORLD',
  'PLATFORM',
];
/** Ordinal of a NON-platform recognition level (PLATFORM is incomparable: undefined). */
export function recognitionRank(level: RecognitionLevel): number | undefined {
  return level === RecognitionLevel.PLATFORM ? undefined : RECOGNITION_ORDER.indexOf(level);
}
/** Non-platform recognition levels at or above `min`, lowest first. */
export function levelsAtOrAbove(min: RecognitionLevel): RecognitionLevel[] {
  const r = recognitionRank(min);
  return r === undefined
    ? []
    : RECOGNITION_ORDER.filter((l) => {
        const x = recognitionRank(l);
        return x !== undefined && x >= r;
      });
}
export const ALL_RECOGNITION_LEVELS = RECOGNITION_ORDER;

export type KeyTrust =
  | { readonly trust: 'TRUSTED' }
  | { readonly trust: 'SUSPECT' | 'INVALID'; readonly reason: string };

export interface TraceDecision {
  readonly principalId: string;
  readonly factId?: string;
  readonly capability: Capability;
  readonly recognitionLevel?: RecognitionLevel;
  readonly atTime: string;
  readonly authorized: boolean;
  readonly reason: string;
  readonly anchorId?: string;
  readonly anchorLevels?: readonly RecognitionLevel[];
  readonly grantChain: readonly string[];
  readonly conflictCheck: 'CLEAR' | 'CONFLICTED' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  readonly proofDigest: string;
}

export interface AuthoritySubject {
  readonly principalId: string;
  readonly keyId?: string;
  readonly signedAt?: string;
  /** Effective time T: the platform-observed issuedAt (or a transition's recordedAt). */
  readonly atTime: string;
  readonly factId?: string;
}

/** How specific a denial is (the trace keeps the most informative attempt per capability). */
const SPECIFICITY: Readonly<Record<string, number>> = {
  AUTHORIZED: 100,
  CONFLICT_OF_INTEREST: 90,
  CONFLICT_CHECK_UNAVAILABLE: 85,
  KEY_COMPROMISED: 80,
  KEY_REVOKED: 80,
  KEY_NOT_VALID_AT_TIME: 80,
  KEY_NOT_OWNED: 80,
  KEY_UNKNOWN: 80,
  GRANT_REVOKED: 70,
  GRANT_NOT_VALID_AT_TIME: 70,
  ANCHOR_REVOKED: 60,
  ANCHOR_NOT_VALID_AT_TIME: 60,
  ANCHOR_SCOPE_NOT_COVERED: 60,
  ANCHOR_LEVEL_FORBIDDEN: 60,
  ANCHOR_MISSING: 60,
  CHAIN_BROKEN: 50,
  DELEGATION_NOT_ALLOWED: 50,
  CAPABILITY_NOT_DELEGABLE: 50,
  DELEGATION_DEPTH_EXCEEDED: 50,
  SCOPE_WIDENED: 50,
  SCOPE_NOT_COVERED: 20,
  NO_GRANT_FOR_CAPABILITY: 10,
  PRINCIPAL_UNKNOWN: 5,
};

const at = (s: string) => new Date(s);

export class EvaluationContext {
  readonly snapshot: VerificationSnapshot;
  readonly submitterId: string;
  readonly scope: AuthorityScope;
  private readonly supported: ReadonlySet<CanonicalFactKind>;
  private readonly keys: ReadonlyMap<string, NonNullable<VerificationSnapshot['keys']>[number]>;
  private readonly participants: ReadonlyMap<
    string,
    NonNullable<VerificationSnapshot['participation']['principals']>[number]
  >;
  private readonly prohibited: ReadonlySet<ParticipationRelation>;
  private readonly facts: AuthorityFacts;
  private readonly checker: ConflictOfInterestChecker;
  private readonly decisions = new Map<string, TraceDecision>();

  constructor(snapshot: VerificationSnapshot) {
    this.snapshot = snapshot;
    this.submitterId = snapshot.resultVersion.submittedByPrincipalId;
    const h = snapshot.hierarchy;
    this.scope = pathToScope({
      level: h.level,
      competitionId: h.competitionId,
      ...(h.region === undefined ? {} : { region: h.region }),
      ...(h.sport === undefined ? {} : { sport: h.sport }),
      ...(h.discipline === undefined ? {} : { discipline: h.discipline }),
      ...(h.eventId === undefined ? {} : { eventId: h.eventId }),
      ...(h.roundId === undefined ? {} : { roundId: h.roundId }),
      ...(h.contestId === undefined ? {} : { contestId: h.contestId }),
    });
    this.supported = new Set(snapshot.supportedFactKinds);
    this.keys = new Map((snapshot.keys ?? []).map((k) => [k.keyId, k]));
    this.participants = new Map(
      (snapshot.participation.principals ?? []).map((p) => [p.principalId, p]),
    );
    this.prohibited = new Set([
      ...STRUCTURAL_CONFLICT_RELATIONS,
      ...(snapshot.policy.spec.conflict?.additionalProhibitedRelations ?? []),
    ]);
    this.facts = toAuthorityFacts(snapshot);
    this.checker = {
      id: 'verification-snapshot-participation/1',
      check: (principalId) => this.conflictStatus(principalId),
    };
  }

  supports(kind: CanonicalFactKind): boolean {
    return this.supported.has(kind);
  }

  // ───────────────────────────── key trust ─────────────────────────────

  /**
   * Key trust at the fact's platform-observed issuedAt (BRT-02 §5.1 rules 1, 4, 5): the key must be
   * the issuer's and valid at T; an ordinary revocation/rotation effective ≤ T invalidates; a
   * compromise with t₀ ≤ T or t₀ ≤ signedAt makes the fact SUSPECT. Only status facts known at the
   * snapshot cutoff exist here, so "as known then" and "as known now" differ exactly by the cutoff.
   * `signedAt` never admits anything.
   */
  keyTrust(fact: SignedFact): KeyTrust {
    const key = this.keys.get(fact.keyId);
    if (key === undefined) return { trust: 'INVALID', reason: Reason.KEY_UNKNOWN };
    if (key.principalId !== fact.issuerPrincipalId)
      return { trust: 'INVALID', reason: Reason.KEY_NOT_OWNED };
    const t = at(fact.issuedAt).getTime();
    if (
      t < at(key.effectiveFrom).getTime() ||
      (key.effectiveTo !== undefined && t >= at(key.effectiveTo).getTime())
    )
      return { trust: 'INVALID', reason: Reason.KEY_NOT_VALID_AT_ISSUANCE };
    const signed = fact.signedAt === undefined ? undefined : at(fact.signedAt).getTime();
    let revoked = false;
    for (const c of key.statusChanges ?? []) {
      if (c.kind === 'COMPROMISED') {
        const t0 = at(c.compromisedSince ?? c.effectiveFrom).getTime();
        if (t >= t0 || (signed !== undefined && signed >= t0))
          return { trust: 'SUSPECT', reason: Reason.KEY_COMPROMISED };
      } else if (at(c.effectiveFrom).getTime() <= t) revoked = true;
    }
    return revoked ? { trust: 'INVALID', reason: Reason.KEY_REVOKED } : { trust: 'TRUSTED' };
  }

  /** A signed fact COUNTS only when its claim is active and its key is trusted. */
  counts(fact: SignedFact): boolean {
    return fact.status === 'ACTIVE' && this.keyTrust(fact).trust === 'TRUSTED';
  }

  // ───────────────────────────── participation ─────────────────────────────

  participation(principalId: string) {
    return this.participants.get(principalId);
  }

  /** Relations established with certainty (STRUCTURAL or DURING_OCCURRENCE; never UNDETERMINED). */
  private certainRelations(principalId: string) {
    return (this.participants.get(principalId)?.relations ?? []).filter(
      (r) => r.timing !== 'UNDETERMINED',
    );
  }

  /** Participant ids whose side this principal is CERTAINLY on (undetermined relations excluded). */
  sidesOf(principalId: string): ReadonlySet<string> {
    return new Set(
      this.certainRelations(principalId)
        .map((r) => r.participantId)
        .filter((id): id is string => id !== undefined),
    );
  }

  /** PLATFORM and SYSTEM principals can never be participants (no athlete / team mapping). */
  private cannotParticipate(principalId: string): boolean {
    const t = this.participants.get(principalId)?.principalType;
    return t === 'PLATFORM' || t === 'SYSTEM';
  }

  /**
   * Whether "this principal is on no side" is PROVEN. Unresolved principals, and principals with no
   * side relation while some side is unresolved, cannot be proven independent (fail closed).
   */
  sideKnowledge(principalId: string): 'KNOWN' | 'UNKNOWN' {
    const p = this.participants.get(principalId);
    if (p === undefined || p.resolution === 'UNRESOLVED') return 'UNKNOWN';
    // A certain side relation is known even when another relation is temporally undetermined.
    if (p.resolution === 'TEMPORALLY_UNDETERMINED')
      return this.sidesOf(principalId).size > 0 ? 'KNOWN' : 'UNKNOWN';
    if (this.cannotParticipate(principalId)) return 'KNOWN';
    if (this.sidesOf(principalId).size > 0) return 'KNOWN';
    return this.snapshot.participation.sidesComplete ? 'KNOWN' : 'UNKNOWN';
  }

  /**
   * Conflict-of-interest answer for the BRT-03 engine (BRT-01 §4.5 rule 7 + policy relations).
   * Relations are FACTS; the rule decides. Missing data is never "conflict-free".
   */
  conflictStatus(principalId: string): 'CLEAR' | 'CONFLICTED' | 'UNAVAILABLE' {
    const p = this.participants.get(principalId);
    if (p === undefined || p.resolution === 'UNRESOLVED') return 'UNAVAILABLE';
    // A CERTAIN prohibited relation (e.g. a direct Participant) conflicts regardless of any other
    // relation's temporal uncertainty; an undetermined relation can never clear a principal.
    if (this.certainRelations(principalId).some((r) => this.prohibited.has(r.kind)))
      return 'CONFLICTED';
    if (p.resolution !== 'RESOLVED') return 'UNAVAILABLE';
    return this.sideKnowledge(principalId) === 'KNOWN' ? 'CLEAR' : 'UNAVAILABLE';
  }

  /**
   * BRT-01 V1 registered official: a REGISTERED_OFFICIAL fact for this principal whose subject
   * covers the result's hierarchy and whose interval contains `atTime` (the attestation's
   * issuedAt). Structural only — no AuthorityGrant is consulted. Callers must first check
   * `supports('REGISTERED_OFFICIAL')`.
   */
  registeredOfficial(principalId: string, atTime: string): string | undefined {
    const h = this.snapshot.hierarchy;
    const t = at(atTime).getTime();
    return [...(this.snapshot.registeredOfficials ?? [])]
      .sort((a, b) => (a.registrationId < b.registrationId ? -1 : 1))
      .find(
        (r) =>
          r.principalId === principalId &&
          ((r.subjectLevel === 'COMPETITION' && r.subjectId === h.competitionId) ||
            (r.subjectLevel === 'EVENT' && r.subjectId === h.eventId) ||
            (r.subjectLevel === 'CONTEST' && r.subjectId === h.contestId)) &&
          at(r.effectiveFrom).getTime() <= t &&
          (r.effectiveTo === undefined || t < at(r.effectiveTo).getTime()),
      )?.registrationId;
  }

  participationTrace(principalId: string) {
    const p = this.participants.get(principalId);
    if (p === undefined || p.resolution === 'UNRESOLVED')
      return [{ principalId, relation: 'UNRESOLVED' }];
    return (p.relations ?? []).map((r) => ({
      principalId,
      relation: r.kind as string,
      ...(r.participantId === undefined ? {} : { participantId: r.participantId }),
      timing: r.timing,
    }));
  }

  // ───────────────────────────── authority ─────────────────────────────

  /**
   * One BRT-03 evaluation: capability C over the resolved hierarchy (+ an explicit recognition
   * level, never inferred) at effective time T = the fact's issuedAt. Grants recorded later cannot
   * authorize an earlier fact: validity windows are checked at T and no grant may be backdated.
   */
  authorizeOnce(
    subject: AuthoritySubject,
    capability: Capability,
    recognitionLevel?: RecognitionLevel,
  ): TraceDecision {
    const cacheKey = [
      subject.principalId,
      subject.keyId ?? '',
      subject.signedAt ?? '',
      subject.atTime,
      capability,
      recognitionLevel ?? '',
    ].join('|');
    const cached = this.decisions.get(cacheKey);
    if (cached !== undefined) return { ...cached, ...opt('factId', subject.factId) };
    const scope: AuthorityScope =
      recognitionLevel === undefined
        ? this.scope
        : { ...this.scope, recognitionLevel: [recognitionLevel] };
    const atTime = at(subject.atTime);
    const decision: AuthorizationDecision = authorize(
      this.facts,
      {
        principalId: subject.principalId as Uuid,
        ...(subject.keyId === undefined ? {} : { keyId: subject.keyId as Uuid }),
        ...(subject.signedAt === undefined ? {} : { signedAt: at(subject.signedAt) }),
        capability,
        scope,
        atTime,
        asOf: KNOWLEDGE_HORIZON,
      },
      { conflictChecker: this.checker, evaluatedAt: atTime },
    );
    const anchor = this.facts.anchors.find((a) => a.id === decision.anchorId);
    const trace: TraceDecision = {
      principalId: subject.principalId,
      capability,
      ...opt('recognitionLevel', recognitionLevel),
      atTime: subject.atTime,
      authorized: decision.authorized,
      reason: decision.reason,
      ...opt('anchorId', decision.anchorId),
      ...opt('anchorLevels', anchor?.recognitionScope.recognitionLevel),
      grantChain: decision.grantChain.map((l) => l.grantId),
      conflictCheck: decision.conflictCheck,
      proofDigest: decision.proofDigest,
    };
    this.decisions.set(cacheKey, trace);
    return { ...trace, ...opt('factId', subject.factId) };
  }

  /**
   * Tries each capability × recognition level (deterministic order) and returns the first
   * authorization, plus — for the trace — the most specific attempt per capability.
   */
  authorizeAny(
    subject: AuthoritySubject,
    capabilities: readonly Capability[],
    levels: readonly RecognitionLevel[] = ALL_RECOGNITION_LEVELS,
  ): { readonly authorized?: TraceDecision; readonly attempts: readonly TraceDecision[] } {
    const attempts: TraceDecision[] = [];
    for (const capability of [...capabilities].sort()) {
      let best: TraceDecision | undefined;
      for (const level of levels) {
        const d = this.authorizeOnce(subject, capability, level);
        if (d.authorized) return { authorized: d, attempts: [...attempts, d] };
        if (best === undefined || (SPECIFICITY[d.reason] ?? 0) > (SPECIFICITY[best.reason] ?? 0))
          best = d;
      }
      if (best !== undefined) attempts.push(best);
    }
    return { attempts };
  }

  /** Authority decisions that stopped at "conflict data unavailable" (fail closed → UNKNOWN). */
  static conflictUnknown(attempts: readonly TraceDecision[]): boolean {
    return attempts.some((a) => a.reason === 'CONFLICT_CHECK_UNAVAILABLE');
  }
}

function opt<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** Snapshot authority/key facts → the BRT-03 engine's fact model (no database involved). */
function toAuthorityFacts(s: VerificationSnapshot): AuthorityFacts {
  const principals: Principal[] = (s.authority.principals ?? []).map((p) => ({
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
    ...opt('effectiveTo', k.effectiveTo === undefined ? undefined : at(k.effectiveTo)),
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
  const anchors: AnchorFact[] = (s.authority.anchors ?? []).map((a) => ({
    id: a.anchorId as Uuid,
    principalId: a.principalId as Uuid,
    recognitionScope: a.recognitionScope,
    basisRef: 'snapshot',
    governanceDecisionRef: 'snapshot',
    effectiveFrom: at(a.effectiveFrom),
    ...opt('effectiveTo', a.effectiveTo === undefined ? undefined : at(a.effectiveTo)),
    recordedAt: at(a.recordedAt),
    factHash: a.factHash,
  }));
  const anchorStatusChanges: TrustAnchorStatusChange[] = (
    s.authority.anchorStatusChanges ?? []
  ).map((c) => ({
    id: c.statusChangeId as Uuid,
    anchorId: c.anchorId as Uuid,
    kind: 'REVOKED',
    effectiveFrom: at(c.effectiveFrom),
    recordedAt: at(c.recordedAt),
    reason: 'snapshot',
  }));
  const grants: AuthorityGrant[] = (s.authority.grants ?? []).map((g) => ({
    id: g.grantId as Uuid,
    grantorPrincipalId: g.grantorPrincipalId as Uuid,
    granteePrincipalId: g.granteePrincipalId as Uuid,
    ...opt('parentGrantId', g.parentGrantId as Uuid | undefined),
    capabilities: g.capabilities,
    scope: g.scope,
    delegation: {
      allowed: g.delegation.allowed,
      maxDepth: g.delegation.maxDepth,
      capabilitiesDelegable: g.delegation.capabilitiesDelegable ?? [],
    },
    constraints: { mustNotBeParticipant: true },
    effectiveFrom: at(g.effectiveFrom),
    ...opt('effectiveTo', g.effectiveTo === undefined ? undefined : at(g.effectiveTo)),
    grantHash: g.grantHash,
    recordedAt: at(g.recordedAt),
  }));
  const grantStatusChanges: GrantStatusChange[] = (s.authority.grantStatusChanges ?? []).map(
    (c) => ({
      id: c.statusChangeId as Uuid,
      grantId: c.grantId as Uuid,
      kind: 'REVOKED',
      compromise: c.compromise,
      effectiveFrom: at(c.effectiveFrom),
      recordedAt: at(c.recordedAt),
      reason: 'snapshot',
    }),
  ) as GrantStatusChange[];
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
