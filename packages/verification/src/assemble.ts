import { platformCanonicalizer, DomainTag, SchemaRef } from '@br/schemas';
import {
  DomainError,
  DomainErrorCode,
  EvidenceType,
  PRODUCTION_SUPPORTED_FACT_KINDS,
  toCanonicalTimestamp,
  type AuthorityScope,
  type Capability,
  type EvidenceAttachmentRole,
  type EvidenceAvailability,
  type EvidenceSourceKind,
  type GeneratorKind,
  type ParticipationRelation,
  type ParticipationResolution,
  type PrincipalType,
  type RecognitionScope,
  type RelationTiming,
  type ResultScopeType,
  type ResultVersionStatus,
} from '@br/domain';
import {
  buildEvidenceBundle,
  detachedJwsHash,
  hashDescriptorDocument,
  hashStatement,
  jwsDetachedVerifier,
  type BundleFacts,
} from '@br/evidence';
import { validatePolicySpec } from './policy';
import { sealSnapshot, type SnapshotEnvelope, type VerificationSnapshot } from './snapshot';
import type { ConditionAspect, SignedFactStatus } from './snapshot';

/**
 * Production snapshot assembly (pure part). The persistence layer loads RAW canonical facts — a
 * superset, in any order — and this function:
 *
 *   1. enforces time consistency (a CURRENT evaluation whose cutoff predates already-recorded facts
 *      fails closed with VERIFICATION_TIME_INCONSISTENT; nothing is clamped or rewritten);
 *   2. applies the knowledge cutoff (facts with recordedAt ≤ asOf only);
 *   3. re-verifies every stored canonical fact against its own hash/signature — content hash,
 *      evidence descriptors, attestation / retraction statements and their JWS proofs with the
 *      registered key material, the policy spec hash — and raises VERIFICATION_INTEGRITY_FAILURE on
 *      any contradiction (never a criterion failure);
 *   4. rebuilds the BRT-06 Evidence Bundle (its facts are projected into the snapshot; its hash,
 *      which embeds the cutoff, is returned as run metadata — never as a snapshot member);
 *   5. resolves participation structurally (relations are facts; policy decides conflicts);
 *   6. emits ONLY fact kinds that today's canonical producers exist for — RESULT_ACCURATE and
 *      CONDITIONS_COMPLIANT attestations. RESULT_OFFICIAL, T5, COMPETITION_SANCTIONED,
 *      IDENTITY_CONFIRMED, official evidence sets, evidence assessments, record categories,
 *      RECORD_RATIFIED and REVIEW_COMPLETED are never manufactured, defaulted or inferred.
 */
export const ASSEMBLER_VERSION = 'verification-assembler/1';

export interface RawPolicy {
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly code: string;
  readonly version: number;
  readonly spec: unknown;
  readonly specHash: string;
}

export interface RawVerificationFacts {
  readonly policy: RawPolicy;
  readonly resultVersion: {
    readonly resultVersionId: string;
    readonly resultId: string;
    readonly versionNumber: number;
    readonly contentHash: string;
    readonly contentSchema: string;
    readonly content: unknown;
    readonly submittedByPrincipalId: string;
    readonly recordedAt: Date;
    readonly scopeType: ResultScopeType;
    readonly scopeTargetId: string;
  };
  readonly statusTransitions: readonly {
    readonly toStatus: ResultVersionStatus;
    readonly recordedAt: Date;
    readonly seq: number;
  }[];
  readonly supersedingVersions: readonly {
    readonly resultVersionId: string;
    readonly recordedAt: Date;
  }[];
  readonly hierarchy: {
    readonly level: 'COMPETITION' | 'EVENT' | 'ROUND' | 'CONTEST';
    readonly competitionId: string;
    readonly eventId?: string;
    readonly roundId?: string;
    readonly contestId?: string;
    readonly sport?: string;
    readonly discipline?: string;
    readonly region?: string;
  };
  readonly discipline: {
    readonly disciplineVersionId?: string;
    readonly evidenceExpectations?: readonly string[];
  };
  readonly bundleFacts: BundleFacts;
  /** Stored descriptors (re-hashed here). */
  readonly storedEvidence: readonly {
    readonly evidenceId: string;
    readonly descriptor: unknown;
    readonly descriptorHash: string;
    readonly contentHash: string;
  }[];
  /** Stored statements + proofs (re-hashed and re-verified here). */
  readonly storedAttestations: readonly {
    readonly attestationId: string;
    readonly statement: unknown;
    readonly statementHash: string;
    readonly proof: unknown;
    readonly keyId: string;
  }[];
  readonly storedRetractions: readonly {
    readonly retractionId: string;
    readonly statement: unknown;
    readonly statementHash: string;
    readonly proof: unknown;
    readonly keyId: string;
  }[];
  readonly keys: readonly {
    readonly keyId: string;
    readonly principalId: string;
    readonly keyKind: string;
    readonly algorithm: string;
    readonly verificationMaterial: Readonly<Record<string, unknown>>;
    readonly factHash: string;
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date;
    readonly recordedAt: Date;
  }[];
  readonly keyStatusChanges: readonly {
    readonly statusChangeId: string;
    readonly keyId: string;
    readonly kind: 'ROTATED' | 'REVOKED' | 'COMPROMISED';
    readonly effectiveFrom: Date;
    readonly compromisedSince?: Date;
    readonly recordedAt: Date;
  }[];
  readonly authority: {
    readonly principals: readonly {
      readonly principalId: string;
      readonly principalType: PrincipalType;
      readonly recordedAt: Date;
    }[];
    readonly anchors: readonly {
      readonly anchorId: string;
      readonly principalId: string;
      readonly recognitionScope: RecognitionScope;
      readonly factHash: string;
      readonly effectiveFrom: Date;
      readonly effectiveTo?: Date;
      readonly recordedAt: Date;
    }[];
    readonly anchorStatusChanges: readonly {
      readonly statusChangeId: string;
      readonly anchorId: string;
      readonly effectiveFrom: Date;
      readonly recordedAt: Date;
    }[];
    readonly grants: readonly {
      readonly grantId: string;
      readonly grantorPrincipalId: string;
      readonly granteePrincipalId: string;
      readonly parentGrantId?: string;
      readonly capabilities: readonly Capability[];
      readonly scope: AuthorityScope;
      readonly delegation: {
        readonly allowed: boolean;
        readonly maxDepth: number;
        readonly capabilitiesDelegable?: readonly Capability[];
      };
      readonly grantHash: string;
      readonly effectiveFrom: Date;
      readonly effectiveTo?: Date;
      readonly recordedAt: Date;
    }[];
    readonly grantStatusChanges: readonly {
      readonly statusChangeId: string;
      readonly grantId: string;
      readonly compromise: boolean;
      readonly effectiveFrom: Date;
      readonly recordedAt: Date;
    }[];
  };
  readonly participation: RawParticipation;
}

/** One lifecycle status fact of a time-bounded relation (status time = transaction time). */
export interface RawStatusChange {
  readonly status: string;
  readonly recordedAt: Date;
}

/** Structural participation rows (ids only; no PII, no profiles). */
export interface RawParticipation {
  /** CONTEST scope: the contest's slots; undefined for classification scopes. */
  readonly contestants?: readonly { readonly participantId?: string; readonly recordedAt: Date }[];
  /** CONTEST scope: the contest's status transitions (IN_PROGRESS / COMPLETED bound occurrence). */
  readonly contestStatusChanges?: readonly RawStatusChange[];
  readonly participants: readonly {
    readonly participantId: string;
    readonly kind: 'INDIVIDUAL' | 'TEAM';
    readonly athleteId?: string;
    readonly teamId?: string;
    readonly recordedAt: Date;
  }[];
  readonly athletes: readonly {
    readonly athleteId: string;
    readonly personId: string;
    readonly recordedAt: Date;
  }[];
  /** Temporal memberships: Athlete ∈ Team during [ACTIVE, ENDED/DECLINED) status facts. */
  readonly teamMemberships: readonly {
    readonly teamId: string;
    readonly athleteId: string;
    readonly statusChanges: readonly RawStatusChange[];
  }[];
  /** Team managers carry no end fact: manager from recordedAt onward. */
  readonly teamManagers: readonly {
    readonly teamId: string;
    readonly personId: string;
    readonly recordedAt: Date;
  }[];
  readonly teamOrganizations: readonly {
    readonly teamId: string;
    readonly organizationId: string;
    readonly recordedAt: Date;
  }[];
  /** Members of lineups declared for THIS contest (exact; takes precedence over memberships). */
  readonly lineupMembers: readonly {
    readonly participantId: string;
    readonly athleteId: string;
    readonly recordedAt: Date;
  }[];
  /** Guardian relationships: [max(ACTIVE, effectiveFrom), REVOKED/ENDED). */
  readonly guardians: readonly {
    readonly guardianPersonId: string;
    readonly dependentPersonId: string;
    readonly effectiveFrom: Date;
    readonly statusChanges: readonly RawStatusChange[];
  }[];
  readonly personPrincipals: readonly {
    readonly personId: string;
    readonly principalId: string;
    readonly recordedAt: Date;
  }[];
  readonly organizationPrincipals: readonly {
    readonly organizationId: string;
    readonly principalId: string;
    readonly recordedAt: Date;
  }[];
  readonly organizerOrganizationId: string;
  /** OWNER / ADMIN memberships of the organizer: [ACTIVE, SUSPENDED/ENDED/DECLINED). */
  readonly organizerAdmins: readonly {
    readonly personId: string;
    readonly statusChanges: readonly RawStatusChange[];
  }[];
  /** Operational competition staff: [ACTIVE, ENDED). */
  readonly staff: readonly {
    readonly personId: string;
    readonly statusChanges: readonly RawStatusChange[];
  }[];
}

export type AssemblyMode =
  /** asOf = the evaluation transaction's own database time: every loaded fact must be ≤ asOf. */
  | 'CURRENT'
  /** asOf = an explicit earlier cutoff: facts recorded later are excluded ("as known then"). */
  | 'HISTORICAL';

const integrity = (message: string, reason: string) =>
  new DomainError(DomainErrorCode.VERIFICATION_INTEGRITY_FAILURE, message, { reason });
const ts = toCanonicalTimestamp;
const opt = <K extends string, V>(key: K, value: V | undefined | null): Partial<Record<K, V>> =>
  value === undefined || value === null ? {} : ({ [key]: value } as Record<K, V>);
const sortBy = <T>(xs: readonly T[], key: (x: T) => string) =>
  [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** Every recordedAt the raw facts carry (for the time-consistency check). */
function recordedTimes(raw: RawVerificationFacts): Date[] {
  const b = raw.bundleFacts;
  const p = raw.participation;
  return [
    raw.resultVersion.recordedAt,
    ...raw.statusTransitions.map((x) => x.recordedAt),
    ...raw.supersedingVersions.map((x) => x.recordedAt),
    ...b.evidence.map((x) => x.recordedAt),
    ...b.availabilityChanges.map((x) => x.recordedAt),
    ...b.privacyChanges.map((x) => x.recordedAt),
    ...b.attachments.map((x) => x.recordedAt),
    ...b.attestations.map((x) => x.recordedAt),
    ...b.retractions.map((x) => x.recordedAt),
    ...raw.keys.map((x) => x.recordedAt),
    ...raw.keyStatusChanges.map((x) => x.recordedAt),
    ...raw.authority.principals.map((x) => x.recordedAt),
    ...raw.authority.anchors.map((x) => x.recordedAt),
    ...raw.authority.anchorStatusChanges.map((x) => x.recordedAt),
    ...raw.authority.grants.map((x) => x.recordedAt),
    ...raw.authority.grantStatusChanges.map((x) => x.recordedAt),
    ...(p.contestants ?? []).map((x) => x.recordedAt),
    ...(p.contestStatusChanges ?? []).map((x) => x.recordedAt),
    ...p.teamMemberships.flatMap((x) => x.statusChanges.map((c) => c.recordedAt)),
    ...p.guardians.flatMap((x) => x.statusChanges.map((c) => c.recordedAt)),
    ...p.organizerAdmins.flatMap((x) => x.statusChanges.map((c) => c.recordedAt)),
    ...p.staff.flatMap((x) => x.statusChanges.map((c) => c.recordedAt)),
    ...p.teamManagers.map((x) => x.recordedAt),
    ...p.participants.map((x) => x.recordedAt),
    ...p.lineupMembers.map((x) => x.recordedAt),
    ...p.personPrincipals.map((x) => x.recordedAt),
    ...p.organizationPrincipals.map((x) => x.recordedAt),
  ];
}

export function assertTimeConsistent(raw: RawVerificationFacts, asOf: Date): void {
  const latest = Math.max(...recordedTimes(raw).map((d) => d.getTime()));
  if (latest > asOf.getTime())
    throw new DomainError(
      DomainErrorCode.VERIFICATION_TIME_INCONSISTENT,
      'the evaluation cutoff predates canonical facts that are already recorded (database clock regression?)',
      { reason: 'CUTOFF_BEFORE_RECORDED_FACTS' },
    );
}

/** Re-verifies stored canonical facts against their own hashes and signatures. */
export function verifyStoredIntegrity(raw: RawVerificationFacts): void {
  const content = platformCanonicalizer();
  let contentHash: string;
  try {
    contentHash = content.hashCanonical(
      DomainTag.resultVersionContent,
      SchemaRef.resultVersionContent.id,
      SchemaRef.resultVersionContent.version,
      raw.resultVersion.content,
    ).contentHash;
  } catch {
    throw integrity('stored result content is not canonical', 'CONTENT_NOT_CANONICAL');
  }
  if (contentHash !== raw.resultVersion.contentHash)
    throw integrity(
      'stored result content does not match its content hash',
      'CONTENT_HASH_MISMATCH',
    );

  const policy = validatePolicySpec(raw.policy.spec);
  if (!policy.ok || policy.specHash !== raw.policy.specHash)
    throw integrity('stored policy spec does not match its hash', 'POLICY_HASH_MISMATCH');

  for (const e of raw.storedEvidence) {
    let h: string;
    let sha: unknown;
    try {
      const d = hashDescriptorDocument(e.descriptor);
      h = d.descriptorHash;
      sha = (d.descriptor as unknown as { content: { sha256: string } }).content.sha256;
    } catch {
      throw integrity('stored evidence descriptor is not canonical', 'DESCRIPTOR_NOT_CANONICAL');
    }
    if (h !== e.descriptorHash || sha !== e.contentHash)
      throw integrity(
        'stored evidence descriptor does not match its hashes',
        'DESCRIPTOR_HASH_MISMATCH',
      );
  }

  const keys = new Map(raw.keys.map((k) => [k.keyId, k]));
  const verify = (
    kind: 'attestation' | 'attestation-retraction',
    row: { statement: unknown; statementHash: string; proof: unknown; keyId: string },
  ) => {
    let h: string;
    try {
      h = hashStatement(kind, row.statement).statementHash;
    } catch {
      throw integrity(`stored ${kind} statement is not canonical`, 'STATEMENT_NOT_CANONICAL');
    }
    if (h !== row.statementHash)
      throw integrity(
        `stored ${kind} statement does not match its hash`,
        'STATEMENT_HASH_MISMATCH',
      );
    const key = keys.get(row.keyId);
    if (key === undefined)
      throw integrity(`${kind} signing key is missing`, 'KEY_MATERIAL_MISSING');
    const ok = jwsDetachedVerifier.verify({
      statementHash: row.statementHash,
      keyId: key.keyId,
      keyKind: key.keyKind,
      algorithm: key.algorithm,
      verificationMaterial: key.verificationMaterial,
      proof: row.proof,
    }).ok;
    if (!ok) throw integrity(`stored ${kind} proof does not verify`, 'SIGNATURE_INVALID');
  };
  const bundleProofs = new Map(
    raw.bundleFacts.attestations.map((a) => [a.attestationId, a.proofHash]),
  );
  for (const a of raw.storedAttestations) {
    verify('attestation', a);
    const expected = bundleProofs.get(a.attestationId);
    if (expected !== undefined && detachedJwsHash(a.proof as never) !== expected)
      throw integrity('stored proof does not match its proof hash', 'PROOF_HASH_MISMATCH');
  }
  for (const r of raw.storedRetractions) verify('attestation-retraction', r);
}

const KNOWN_EVIDENCE_TYPES = new Set<string>(Object.values(EvidenceType));

/** Statuses that neither open nor close an interval (proposals / invitations / pending). */
const PRE_ACTIVE = new Set(['PROPOSED', 'INVITED', 'PENDING']);

/** Half-open validity intervals [from, to) of a relation from its status facts known at the cutoff. */
export function activeIntervals(
  changes: readonly RawStatusChange[],
  asOf: Date,
  notBefore?: Date,
): { from: number; to?: number }[] {
  const out: { from: number; to?: number }[] = [];
  let open: number | undefined;
  const known = changes
    .filter((c) => c.recordedAt.getTime() <= asOf.getTime())
    .map((c, i) => ({ c, i }))
    .sort((x, y) => x.c.recordedAt.getTime() - y.c.recordedAt.getTime() || x.i - y.i);
  for (const { c } of known) {
    const t = c.recordedAt.getTime();
    if (c.status === 'ACTIVE') {
      if (open === undefined) open = Math.max(t, notBefore?.getTime() ?? t);
    } else if (!PRE_ACTIVE.has(c.status) && open !== undefined) {
      if (t > open) out.push({ from: open, to: t });
      open = undefined;
    }
  }
  if (open !== undefined) out.push({ from: open });
  return out;
}

/**
 * The contest occurrence window W = [from, to] (BRT-07R): `from` = the first IN_PROGRESS status
 * fact known at the cutoff (absent → unknown), `to` = the earliest of the first COMPLETED status
 * fact and the ResultVersion's submission (a result cannot describe play that had not happened).
 * Classification scopes have no contest facts: `from` unknown, `to` = submission. A `from` later
 * than `to` is contradictory and is treated as unknown (never clamped).
 */
export function occurrenceWindow(
  raw: RawParticipation,
  asOf: Date,
  submittedAt: Date,
): { from?: number; to: number } {
  const known = (raw.contestStatusChanges ?? []).filter(
    (c) => c.recordedAt.getTime() <= asOf.getTime(),
  );
  const first = (status: string) => {
    const ts = known.filter((c) => c.status === status).map((c) => c.recordedAt.getTime());
    return ts.length === 0 ? undefined : Math.min(...ts);
  };
  const completed = first('COMPLETED');
  const to = Math.min(submittedAt.getTime(), completed ?? Number.POSITIVE_INFINITY);
  const from = first('IN_PROGRESS');
  return from === undefined || from > to ? { to } : { from, to };
}

type Timing = 'DURING_OCCURRENCE' | 'OUTSIDE' | 'UNDETERMINED';

/** Whether any interval [s, e) certainly overlaps W = [from, to], certainly misses it, or neither. */
export function sliceAt(
  intervals: readonly { from: number; to?: number }[],
  w: { from?: number; to: number },
): Timing {
  let undetermined = false;
  for (const i of intervals) {
    if (i.from > w.to) continue; // began after the occurrence
    if (i.to === undefined) return 'DURING_OCCURRENCE';
    if (w.from !== undefined) {
      if (i.to > w.from) return 'DURING_OCCURRENCE';
      continue; // ended before the occurrence began
    }
    undetermined = true; // ended at some point, but the occurrence start is unknown
  }
  return undetermined ? 'UNDETERMINED' : 'OUTSIDE';
}

const combine = (a: RelationTiming, b: Timing): Timing =>
  b === 'OUTSIDE'
    ? 'OUTSIDE'
    : a === 'UNDETERMINED' || b === 'UNDETERMINED'
      ? 'UNDETERMINED'
      : 'DURING_OCCURRENCE';

/**
 * Structural participation index (BRT-07 §43–46, BRT-07R temporal slicing) over raw rows known at
 * the cutoff. It answers: which PERSON principal is an athlete participant; which principals are on
 * each side; whether a person is a participant / team member / lineup member / manager / guardian;
 * whether an organization organizes the competition or labels a participating team; operational
 * staff. It returns FACTS only — whether a relation disqualifies is the conflict rule's decision.
 *
 * Which time each relation is judged at:
 *   SELF_PARTICIPANT, LINEUP_MEMBER (exact contest lineup), TEAM_AFFILIATED_ORGANIZATION,
 *   ORGANIZER_ORGANIZATION                          STRUCTURAL (timeless for this subject)
 *   TEAM_MEMBER, TEAM_MANAGER, GUARDIAN, ORGANIZER_ORGANIZATION_ADMIN, COMPETITION_STAFF
 *                                                   sliced at the occurrence window W
 *   Person ↔ Principal, Organization ↔ Principal    identity bindings, known at the cutoff
 * A lineup member of participant P is never re-judged by membership in P's team (the exact lineup
 * takes precedence). A relation certainly outside W is dropped; an undecidable one is emitted as
 * UNDETERMINED and makes the principal TEMPORALLY_UNDETERMINED.
 */
export class ParticipationIndex {
  private readonly principalOfPerson = new Map<string, string>();
  private readonly personOfPrincipal = new Map<string, string>();
  private readonly principalOfOrganization = new Map<string, string>();
  private readonly organizationOfPrincipal = new Map<string, string>();
  readonly window: { readonly from?: number; readonly to: number };
  readonly sides: {
    participantId: string;
    participantKind: 'INDIVIDUAL' | 'TEAM';
    athleteIds: Set<string>;
    principalIds: Set<string>;
  }[] = [];
  readonly sidesComplete: boolean;
  /** Principals holding at least one UNDETERMINED relation (must still be projected). */
  readonly undeterminedPrincipals = new Set<string>();
  private readonly relations = new Map<
    string,
    Map<string, { kind: ParticipationRelation; participantId?: string; timing: RelationTiming }>
  >();

  constructor(raw: RawParticipation, asOf: Date, scopeType: ResultScopeType, submittedAt: Date) {
    const known = <T>(rows: readonly T[], at: (r: T) => Date) =>
      rows.filter((r) => at(r).getTime() <= asOf.getTime());
    this.window = occurrenceWindow(raw, asOf, submittedAt);
    const w = this.window;
    const during = (changes: readonly RawStatusChange[], notBefore?: Date) =>
      sliceAt(activeIntervals(changes, asOf, notBefore), w);
    for (const m of known(raw.personPrincipals, (r) => r.recordedAt)) {
      this.principalOfPerson.set(m.personId, m.principalId);
      this.personOfPrincipal.set(m.principalId, m.personId);
    }
    for (const m of known(raw.organizationPrincipals, (r) => r.recordedAt)) {
      this.principalOfOrganization.set(m.organizationId, m.principalId);
      this.organizationOfPrincipal.set(m.principalId, m.organizationId);
    }
    const personOfAthlete = new Map(
      known(raw.athletes, (r) => r.recordedAt).map((a) => [a.athleteId, a.personId]),
    );
    const participants = new Map(
      known(raw.participants, (r) => r.recordedAt).map((p) => [p.participantId, p]),
    );

    let sideIds: string[];
    if (scopeType === 'CONTEST') {
      const slots = known(raw.contestants ?? [], (r) => r.recordedAt);
      sideIds = slots.flatMap((s) => (s.participantId === undefined ? [] : [s.participantId]));
      this.sidesComplete =
        slots.length > 0 &&
        slots.every((s) => s.participantId !== undefined && participants.has(s.participantId));
    } else {
      sideIds = [...participants.keys()];
      this.sidesComplete = true;
    }

    const relate = (
      principalId: string | undefined,
      kind: ParticipationRelation,
      timing: Timing | 'STRUCTURAL',
      participantId?: string,
    ): boolean => {
      if (principalId === undefined || timing === 'OUTSIDE') return false;
      const m = this.relations.get(principalId) ?? new Map();
      const key = `${kind}:${participantId ?? ''}`;
      // A certain relation always wins over an undetermined one for the same (kind, participant).
      const existing = m.get(key)?.timing;
      if (existing !== undefined && existing !== 'UNDETERMINED' && timing === 'UNDETERMINED')
        return true;
      m.set(key, { kind, ...(participantId === undefined ? {} : { participantId }), timing });
      this.relations.set(principalId, m);
      if (timing === 'UNDETERMINED') this.undeterminedPrincipals.add(principalId);
      return timing !== 'UNDETERMINED';
    };
    const memberships = raw.teamMemberships;
    const managers = known(raw.teamManagers, (r) => r.recordedAt);
    const teamOrgs = known(raw.teamOrganizations, (r) => r.recordedAt);
    const lineups = known(raw.lineupMembers, (r) => r.recordedAt);

    for (const id of [...new Set(sideIds)].sort()) {
      const p = participants.get(id);
      if (p === undefined) continue;
      const side = {
        participantId: id,
        participantKind: p.kind,
        athleteIds: new Set<string>(),
        principalIds: new Set<string>(),
      };
      const onSide = (principal: string | undefined, certain: boolean) => {
        if (principal !== undefined && certain) side.principalIds.add(principal);
      };
      const addAthlete = (
        athleteId: string,
        kind: ParticipationRelation,
        timing: 'STRUCTURAL' | Timing,
      ) => {
        if (timing === 'OUTSIDE') return;
        side.athleteIds.add(athleteId);
        const person = personOfAthlete.get(athleteId);
        if (person === undefined) return;
        const principal = this.principalOfPerson.get(person);
        onSide(principal, relate(principal, kind, timing, id));
        for (const g of raw.guardians.filter((x) => x.dependentPersonId === person)) {
          const gp = this.principalOfPerson.get(g.guardianPersonId);
          const t = combine(
            timing === 'STRUCTURAL' ? 'DURING_OCCURRENCE' : timing,
            during(g.statusChanges, g.effectiveFrom),
          );
          onSide(gp, relate(gp, 'GUARDIAN_OF_PARTICIPANT', t, id));
        }
      };
      const lineupAthletes = new Set(
        lineups.filter((x) => x.participantId === id).map((x) => x.athleteId),
      );
      if (p.kind === 'INDIVIDUAL' && p.athleteId !== undefined)
        addAthlete(p.athleteId, 'SELF_PARTICIPANT', 'STRUCTURAL');
      for (const a of [...lineupAthletes].sort())
        addAthlete(a, 'LINEUP_MEMBER_OF_PARTICIPANT', 'STRUCTURAL');
      if (p.kind === 'TEAM' && p.teamId !== undefined) {
        for (const m of memberships.filter(
          (x) => x.teamId === p.teamId && !lineupAthletes.has(x.athleteId),
        ))
          addAthlete(m.athleteId, 'TEAM_MEMBER_OF_PARTICIPANT', during(m.statusChanges));
        for (const m of managers.filter((x) => x.teamId === p.teamId)) {
          const mp = this.principalOfPerson.get(m.personId);
          const t = sliceAt([{ from: m.recordedAt.getTime() }], w);
          onSide(mp, relate(mp, 'TEAM_MANAGER_OF_PARTICIPANT', t, id));
        }
        for (const o of teamOrgs.filter((x) => x.teamId === p.teamId)) {
          const op = this.principalOfOrganization.get(o.organizationId);
          onSide(op, relate(op, 'TEAM_AFFILIATED_ORGANIZATION', 'STRUCTURAL', id));
        }
      }
      this.sides.push(side);
    }
    relate(
      this.principalOfOrganization.get(raw.organizerOrganizationId),
      'ORGANIZER_ORGANIZATION',
      'STRUCTURAL',
    );
    for (const a of raw.organizerAdmins)
      relate(
        this.principalOfPerson.get(a.personId),
        'ORGANIZER_ORGANIZATION_ADMIN',
        during(a.statusChanges),
      );
    for (const st of raw.staff)
      relate(
        this.principalOfPerson.get(st.personId),
        'COMPETITION_STAFF',
        during(st.statusChanges),
      );
  }

  /** PERSON principal of an athlete participant's person (explicit mapping; never Person.id). */
  principalOfAthleteParticipant(participantId: string): readonly string[] {
    return [...(this.sides.find((s) => s.participantId === participantId)?.principalIds ?? [])];
  }

  relationsOf(
    principalId: string,
  ): { kind: ParticipationRelation; participantId?: string; timing: RelationTiming }[] {
    return [...(this.relations.get(principalId)?.values() ?? [])];
  }

  /**
   * RESOLVED when the principal's identity is mappable to structural facts: PLATFORM / SYSTEM
   * (never participants), a PERSON with an explicit Person ↔ Principal mapping, or an ORGANIZATION
   * with its organization mapping — and every time-bounded relation is decided at W. A mapped
   * principal with an undecidable relation is TEMPORALLY_UNDETERMINED; anything else UNRESOLVED.
   */
  resolution(
    principalId: string,
    principalType: PrincipalType | undefined,
  ): ParticipationResolution {
    if (principalType === 'PLATFORM' || principalType === 'SYSTEM') return 'RESOLVED';
    const mapped =
      (principalType === 'PERSON' && this.personOfPrincipal.has(principalId)) ||
      (principalType === 'ORGANIZATION' && this.organizationOfPrincipal.has(principalId));
    if (!mapped) return 'UNRESOLVED';
    return this.relationsOf(principalId).some((r) => r.timing === 'UNDETERMINED')
      ? 'TEMPORALLY_UNDETERMINED'
      : 'RESOLVED';
  }
}

/** Builds the sealed production snapshot. Throws on integrity / time-consistency failures. */
export function assembleSnapshot(
  raw: RawVerificationFacts,
  asOf: Date,
  mode: AssemblyMode,
): SnapshotEnvelope & { readonly evidenceBundleHash: string } {
  if (mode === 'CURRENT') assertTimeConsistent(raw, asOf);
  const t = asOf.getTime();
  const known = <T extends { recordedAt: Date }>(rows: readonly T[]) =>
    rows.filter((r) => r.recordedAt.getTime() <= t);
  if (raw.resultVersion.recordedAt.getTime() > t)
    throw new DomainError(
      DomainErrorCode.INVALID_INPUT,
      'the result version did not exist at the requested cutoff',
    );

  verifyStoredIntegrity(raw);
  const bundle = buildEvidenceBundle(raw.bundleFacts, asOf);
  const doc = bundle.bundle as unknown as {
    evidence: {
      evidenceId: string;
      evidenceType: string;
      contentHash: string;
      descriptorHash: string;
      source: { kind: string; principalId?: string };
      derivation?: { generatorKind: string };
      availability: { status: string };
      attachments?: { targetType: string; targetId: string; role: string }[];
    }[];
    attestations: {
      attestationId: string;
      statementHash: string;
      issuer: { principalId: string; principalType: PrincipalType; keyId: string };
      claim: {
        type: string;
        polarity: 'AFFIRM' | 'DENY';
        payload?: { conditions?: { aspect: string }[] };
      };
      authorityContext?: { actingRole: string };
      proof: { assurance: string };
      signedAt: string;
      issuedAt: string;
      evidenceRefs?: { evidenceId: string }[];
      supersededBy?: string[];
      retraction?: unknown;
    }[];
    lineage: { evidenceId: string; relatedEvidenceId: string }[];
  };
  const rv = raw.resultVersion;

  // Lineage roots: derived / redacted / transformed / superseding copies share their origin.
  const parents = new Map<string, string[]>();
  for (const l of doc.lineage)
    parents.set(l.evidenceId, [...(parents.get(l.evidenceId) ?? []), l.relatedEvidenceId]);
  const rootOf = (id: string, seen = new Set<string>()): string => {
    const ps = (parents.get(id) ?? []).filter((p) => !seen.has(p)).sort();
    if (ps.length === 0) return id;
    seen.add(id);
    return ps.map((p) => rootOf(p, seen)).sort()[0] as string;
  };

  const statusRows = known(raw.statusTransitions).sort(
    (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.seq - b.seq,
  );
  const status = (statusRows[statusRows.length - 1]?.toStatus ?? 'SUBMITTED') as Exclude<
    ResultVersionStatus,
    'DRAFT'
  >;
  const superseding = sortBy(known(raw.supersedingVersions), (v) => v.resultVersionId)[0];
  const entries = (rv.content as { entries?: { participantId: string }[] }).entries ?? [];

  const attestations = doc.attestations.map((a) => {
    const aspects = [
      ...new Set((a.claim.payload?.conditions ?? []).map((c) => c.aspect)),
    ] as ConditionAspect[];
    const status: SignedFactStatus =
      a.retraction !== undefined
        ? 'RETRACTED'
        : (a.supersededBy ?? []).length > 0
          ? 'SUPERSEDED'
          : 'ACTIVE';
    return {
      attestationId: a.attestationId,
      statementHash: a.statementHash,
      issuerPrincipalId: a.issuer.principalId,
      issuerPrincipalType: a.issuer.principalType,
      keyId: a.issuer.keyId,
      assurance: a.proof.assurance,
      issuedAt: a.issuedAt,
      signedAt: a.signedAt,
      proof: 'VERIFIED',
      polarity: a.claim.polarity,
      status,
      claimType: a.claim.type,
      ...opt('actingRole', a.authorityContext?.actingRole),
      ...opt(
        'evidenceIds',
        a.evidenceRefs?.map((r) => r.evidenceId),
      ),
      ...opt('conditionAspects', aspects.length === 0 ? undefined : aspects),
    };
  });

  // Keys: the issuers' keys and their status changes known at the cutoff (compromise is retroactive).
  const keyIds = new Set(doc.attestations.map((a) => a.issuer.keyId));
  const keys = known(raw.keys)
    .filter((k) => keyIds.has(k.keyId))
    .map((k) => ({
      keyId: k.keyId,
      principalId: k.principalId,
      keyKind: k.keyKind,
      algorithm: k.algorithm,
      factHash: k.factHash,
      effectiveFrom: ts(k.effectiveFrom),
      ...opt('effectiveTo', k.effectiveTo === undefined ? undefined : ts(k.effectiveTo)),
      recordedAt: ts(k.recordedAt),
      statusChanges: known(raw.keyStatusChanges)
        .filter((c) => c.keyId === k.keyId)
        .map((c) => ({
          statusChangeId: c.statusChangeId,
          kind: c.kind,
          effectiveFrom: ts(c.effectiveFrom),
          ...opt(
            'compromisedSince',
            c.compromisedSince === undefined ? undefined : ts(c.compromisedSince),
          ),
          recordedAt: ts(c.recordedAt),
        })),
    }));

  // Authority: only facts known at the cutoff (the BRT-03 engine re-walks every chain itself).
  const a = raw.authority;
  const principalTypes = new Map(known(a.principals).map((p) => [p.principalId, p.principalType]));
  const authority = {
    principals: known(a.principals).map((p) => ({
      principalId: p.principalId,
      principalType: p.principalType,
      recordedAt: ts(p.recordedAt),
    })),
    anchors: known(a.anchors).map((x) => ({
      anchorId: x.anchorId,
      principalId: x.principalId,
      recognitionScope: x.recognitionScope,
      factHash: x.factHash,
      effectiveFrom: ts(x.effectiveFrom),
      ...opt('effectiveTo', x.effectiveTo === undefined ? undefined : ts(x.effectiveTo)),
      recordedAt: ts(x.recordedAt),
    })),
    anchorStatusChanges: known(a.anchorStatusChanges).map((x) => ({
      statusChangeId: x.statusChangeId,
      anchorId: x.anchorId,
      effectiveFrom: ts(x.effectiveFrom),
      recordedAt: ts(x.recordedAt),
    })),
    grants: known(a.grants).map((g) => ({
      grantId: g.grantId,
      grantorPrincipalId: g.grantorPrincipalId,
      granteePrincipalId: g.granteePrincipalId,
      ...opt('parentGrantId', g.parentGrantId),
      capabilities: g.capabilities,
      scope: g.scope,
      delegation: {
        allowed: g.delegation.allowed,
        maxDepth: g.delegation.maxDepth,
        ...opt('capabilitiesDelegable', g.delegation.capabilitiesDelegable),
      },
      grantHash: g.grantHash,
      effectiveFrom: ts(g.effectiveFrom),
      ...opt('effectiveTo', g.effectiveTo === undefined ? undefined : ts(g.effectiveTo)),
      recordedAt: ts(g.recordedAt),
    })),
    grantStatusChanges: known(a.grantStatusChanges).map((c) => ({
      statusChangeId: c.statusChangeId,
      grantId: c.grantId,
      compromise: c.compromise,
      effectiveFrom: ts(c.effectiveFrom),
      recordedAt: ts(c.recordedAt),
    })),
  };

  // Participation: the structural index, projected onto every principal the engine may ask about.
  const index = new ParticipationIndex(raw.participation, asOf, rv.scopeType, rv.recordedAt);
  const relevant = new Set<string>([
    rv.submittedByPrincipalId,
    ...attestations.map((x) => x.issuerPrincipalId),
    ...doc.evidence.flatMap((e) =>
      e.source.principalId === undefined ? [] : [e.source.principalId],
    ),
    ...index.sides.flatMap((s) => [...s.principalIds]),
    ...index.undeterminedPrincipals,
  ]);
  const participation = {
    sidesComplete: index.sidesComplete,
    occurrenceWindow: {
      ...(index.window.from === undefined ? {} : { from: ts(new Date(index.window.from)) }),
      to: ts(new Date(index.window.to)),
    },
    sides: index.sides.map((s) => ({
      participantId: s.participantId,
      participantKind: s.participantKind,
      athleteIds: [...s.athleteIds],
      principalIds: [...s.principalIds],
    })),
    principals: [...relevant].sort().flatMap((principalId) => {
      const principalType = principalTypes.get(principalId);
      if (principalType === undefined) return [];
      return [
        {
          principalId,
          principalType,
          resolution: index.resolution(principalId, principalType),
          relations: index.relationsOf(principalId),
        },
      ];
    }),
  };

  const policy = validatePolicySpec(raw.policy.spec);
  if (!policy.ok) throw integrity('stored policy spec is invalid', 'POLICY_INVALID');
  const snapshot: VerificationSnapshot = {
    provenance: 'CANONICAL_ASSEMBLY',
    assembler: ASSEMBLER_VERSION,
    policy: {
      policyId: raw.policy.policyId,
      policyVersionId: raw.policy.policyVersionId,
      code: raw.policy.code,
      version: raw.policy.version,
      specHash: raw.policy.specHash,
      spec: policy.spec,
    },
    resultVersion: {
      resultVersionId: rv.resultVersionId,
      resultId: rv.resultId,
      versionNumber: rv.versionNumber,
      contentHash: rv.contentHash,
      contentSchema: rv.contentSchema,
      submittedByPrincipalId: rv.submittedByPrincipalId,
      submittedAt: ts(rv.recordedAt),
      status,
      ...opt('supersededByVersionId', superseding?.resultVersionId),
      scopeType: rv.scopeType,
      scopeTargetId: rv.scopeTargetId,
      entryParticipantIds: [...new Set(entries.map((e) => e.participantId))],
    },
    hierarchy: raw.hierarchy,
    discipline: {
      ...opt('disciplineVersionId', raw.discipline.disciplineVersionId),
      primaryEvidenceTypes: [...new Set(raw.discipline.evidenceExpectations ?? [])].filter((x) =>
        KNOWN_EVIDENCE_TYPES.has(x),
      ) as EvidenceType[],
    },
    evidence: doc.evidence.map((e) => ({
      evidenceId: e.evidenceId,
      evidenceType: e.evidenceType as EvidenceType,
      contentHash: e.contentHash,
      descriptorHash: e.descriptorHash,
      sourceKind: e.source.kind as EvidenceSourceKind,
      ...opt('sourcePrincipalId', e.source.principalId),
      ...opt('generatorKind', e.derivation?.generatorKind as GeneratorKind | undefined),
      availability: e.availability.status as EvidenceAvailability,
      versionRoles: [
        ...new Set(
          (e.attachments ?? [])
            .filter((x) => x.targetType === 'RESULT_VERSION' && x.targetId === rv.resultVersionId)
            .map((x) => x.role as EvidenceAttachmentRole),
        ),
      ],
      provenanceRootId: rootOf(e.evidenceId),
      integrity: 'VERIFIED',
    })),
    attestations: attestations as unknown as NonNullable<VerificationSnapshot['attestations']>,
    supportedFactKinds: PRODUCTION_SUPPORTED_FACT_KINDS,
    keys: keys as unknown as NonNullable<VerificationSnapshot['keys']>,
    authority,
    participation,
  };
  return { ...sealSnapshot(snapshot, ts(asOf)), evidenceBundleHash: bundle.bundleHash };
}
