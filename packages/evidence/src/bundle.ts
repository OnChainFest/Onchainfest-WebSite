import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  DomainError,
  DomainErrorCode,
  toCanonicalTimestamp,
  type EvidenceAvailability,
  type EvidencePrivacyClass,
  type Instant,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import type { AttestationStatement } from './statement';

/**
 * Deterministic Evidence Bundle (`br:evidence-bundle@1`) — the BRT-06 → BRT-07 handoff.
 *
 * For ONE exact ResultVersion and a transaction-time horizon `asOf`, it gathers every immutable
 * fact BRT-07 needs, as known at asOf (facts with recordedAt ≤ asOf):
 *   - the ResultVersion identity, content hash and resolved hierarchy scope;
 *   - evidence ATTACHED to that version (or to its contest/event), CITED by its attestations, and
 *     their LINEAGE ancestors — descriptor/content hashes, sources, captured/received times,
 *     availability and privacy class at asOf, attachments;
 *   - every attestation whose subject is that version: statement hash, issuer principal + type,
 *     key, proof scheme, claim, evidence refs, supersession and retraction state;
 *   - the key facts (validity window + status changes with their recordedAt) so BRT-07 can apply
 *     retroactive-compromise semantics "as known now" or "as known then".
 *
 * It contains NO verdict, level, score, authority decision or mutable display name. Sets are
 * sorted by BR-JSON set semantics, so the output is independent of load/insertion order, and
 * nothing reads the clock: same facts + same asOf ⇒ same canonical bytes ⇒ same `bundleHash`.
 *
 *   bundleHash = H("evidence-bundle", "br:evidence-bundle@1", JCS(bundle))
 *
 * `bundleHash` identifies the exact input set. It is not a verification proof, not a truth hash
 * and not a blockchain proof.
 */
export interface BundleEvidenceFact {
  readonly evidenceId: string;
  readonly evidenceType: string;
  readonly descriptorHash: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly source: {
    readonly kind: string;
    readonly principalId?: string;
    readonly principalType?: string;
    readonly capturedAt?: Instant;
    readonly capturedAtAssurance: string;
  };
  readonly derivation?: {
    readonly generatorKind: string;
    readonly systemId: string;
    readonly version: string;
    readonly configurationHash?: string;
  };
  readonly lineage: readonly {
    readonly relation: string;
    readonly evidenceId: string;
    readonly descriptorHash: string;
  }[];
  readonly receivedAt: Instant;
  readonly recordedAt: Instant;
}

export interface BundleFacts {
  readonly resultVersion: {
    readonly resultVersionId: string;
    readonly resultId: string;
    readonly versionNumber: number;
    readonly contentHash: string;
    readonly contentSchema: string;
    readonly scope: {
      readonly scopeType: string;
      readonly scopeTargetId: string;
      readonly competitionId?: string;
      readonly eventId?: string;
      readonly roundId?: string;
      readonly contestId?: string;
      readonly sport?: string;
      readonly discipline?: string;
      readonly region?: string;
    };
  };
  /** A superset is fine: only items reachable from the result version at asOf are included. */
  readonly evidence: readonly BundleEvidenceFact[];
  readonly availabilityChanges: readonly {
    readonly evidenceId: string;
    readonly toStatus: EvidenceAvailability;
    readonly recordedAt: Instant;
    readonly seq: number;
  }[];
  readonly privacyChanges: readonly {
    readonly evidenceId: string;
    readonly toClass: EvidencePrivacyClass;
    readonly recordedAt: Instant;
    readonly seq: number;
  }[];
  readonly attachments: readonly {
    readonly attachmentId: string;
    readonly evidenceId: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly role: string;
    readonly recordedAt: Instant;
  }[];
  readonly attestations: readonly {
    readonly attestationId: string;
    readonly statementHash: string;
    readonly statement: AttestationStatement;
    readonly issuerPrincipalType: string;
    readonly algorithm: string;
    readonly proofType: string;
    readonly proofScheme: string;
    readonly assurance: string;
    readonly verifierId: string;
    readonly proofHash: string;
    readonly issuedAt: Instant;
    readonly recordedAt: Instant;
    readonly supersedesAttestationId?: string;
  }[];
  readonly retractions: readonly {
    readonly retractionId: string;
    readonly attestationId: string;
    readonly statementHash: string;
    readonly keyId: string;
    readonly proofHash: string;
    readonly reasonCode: string;
    readonly issuedAt: Instant;
    readonly recordedAt: Instant;
  }[];
  readonly keys: readonly {
    readonly keyId: string;
    readonly principalId: string;
    readonly factHash: string;
    readonly verificationMaterialHash: string;
    readonly keyKind: string;
    readonly algorithm: string;
    readonly effectiveFrom: Instant;
    readonly effectiveTo?: Instant;
    readonly recordedAt: Instant;
  }[];
  readonly keyStatusChanges: readonly {
    readonly statusChangeId: string;
    readonly keyId: string;
    readonly kind: string;
    readonly effectiveFrom: Instant;
    readonly recordedAt: Instant;
    readonly factHash: string;
  }[];
}

export interface EvidenceBundleResult {
  readonly bundle: Record<string, unknown>;
  readonly bundleHash: ContentHash;
  readonly canonicalText: string;
}

const MAX_LINEAGE_DEPTH = 32;
const ts = toCanonicalTimestamp;
const opt = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

function latestAt<T extends { recordedAt: Instant; seq: number }>(
  rows: readonly T[],
  asOf: number,
): T | undefined {
  let best: T | undefined;
  for (const r of rows) {
    if (r.recordedAt.getTime() > asOf) continue;
    if (
      best === undefined ||
      r.recordedAt.getTime() > best.recordedAt.getTime() ||
      (r.recordedAt.getTime() === best.recordedAt.getTime() && r.seq > best.seq)
    )
      best = r;
  }
  return best;
}

export function buildEvidenceBundle(facts: BundleFacts, asOf: Instant): EvidenceBundleResult {
  const horizon = asOf.getTime();
  if (Number.isNaN(horizon)) throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid asOf');
  const known = <T extends { recordedAt: Instant }>(rows: readonly T[]) =>
    rows.filter((r) => r.recordedAt.getTime() <= horizon);
  const rv = facts.resultVersion;

  // Targets whose attachments concern this exact version: the version itself, its contest and
  // event (context). Attachments to other versions of the same Result are never pulled in.
  const targets = new Set<string>([`RESULT_VERSION:${rv.resultVersionId}`]);
  if (rv.scope.contestId !== undefined) targets.add(`CONTEST:${rv.scope.contestId}`);
  if (rv.scope.eventId !== undefined) targets.add(`EVENT:${rv.scope.eventId}`);

  const items = new Map(known(facts.evidence).map((e) => [e.evidenceId, e]));
  const inclusion = new Map<string, Set<string>>();
  const include = (id: string, why: string) => {
    if (!items.has(id)) return false;
    const set = inclusion.get(id) ?? new Set<string>();
    set.add(why);
    inclusion.set(id, set);
    return true;
  };

  const attachments = known(facts.attachments).filter((a) =>
    targets.has(`${a.targetType}:${a.targetId}`),
  );
  for (const a of attachments) include(a.evidenceId, 'ATTACHED');

  const attestations = known(facts.attestations).filter(
    (a) =>
      a.statement.subject.type === 'RESULT_VERSION' &&
      a.statement.subject.id === rv.resultVersionId,
  );
  for (const a of attestations)
    for (const r of a.statement.evidenceRefs ?? []) include(r.evidenceId, 'CITED');

  // Lineage ancestors (parents are always recorded before their children).
  let frontier = [...inclusion.keys()];
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of items.get(id)?.lineage ?? []) {
        const isNew = !inclusion.has(edge.evidenceId);
        if (include(edge.evidenceId, 'LINEAGE') && isNew) next.push(edge.evidenceId);
      }
    }
    frontier = next;
  }

  const evidence = [...inclusion.entries()].map(([id, why]) => {
    const e = items.get(id) as BundleEvidenceFact;
    const availability = latestAt(
      facts.availabilityChanges.filter((c) => c.evidenceId === id),
      horizon,
    );
    const privacy = latestAt(
      facts.privacyChanges.filter((c) => c.evidenceId === id),
      horizon,
    );
    if (availability === undefined || privacy === undefined) {
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'evidence lifecycle facts missing for an included item',
      );
    }
    const own = attachments.filter((a) => a.evidenceId === id);
    return {
      evidenceId: e.evidenceId,
      evidenceType: e.evidenceType,
      descriptorHash: e.descriptorHash,
      contentHash: e.contentHash,
      byteLength: e.byteLength,
      mediaType: e.mediaType,
      source: {
        kind: e.source.kind,
        ...opt('principalId', e.source.principalId),
        ...opt('principalType', e.source.principalType),
        ...opt(
          'capturedAt',
          e.source.capturedAt === undefined ? undefined : ts(e.source.capturedAt),
        ),
        capturedAtAssurance: e.source.capturedAtAssurance,
      },
      ...opt('derivation', e.derivation),
      receivedAt: ts(e.receivedAt),
      recordedAt: ts(e.recordedAt),
      availability: { status: availability.toStatus, since: ts(availability.recordedAt) },
      privacyClass: privacy.toClass,
      inclusion: [...why],
      ...opt(
        'attachments',
        own.length === 0
          ? undefined
          : own.map((a) => ({
              attachmentId: a.attachmentId,
              targetType: a.targetType,
              targetId: a.targetId,
              role: a.role,
              recordedAt: ts(a.recordedAt),
            })),
      ),
    };
  });

  const lineage = [...inclusion.keys()].flatMap((id) =>
    (items.get(id)?.lineage ?? []).map((l) => ({
      evidenceId: id,
      relation: l.relation,
      relatedEvidenceId: l.evidenceId,
      relatedDescriptorHash: l.descriptorHash,
    })),
  );

  const retractions = known(facts.retractions);
  const keyIds = new Set<string>();
  const attestationDocs = attestations.map((a) => {
    const s = a.statement;
    keyIds.add(s.issuer.keyId);
    const retraction = retractions.find((r) => r.attestationId === a.attestationId);
    if (retraction !== undefined) keyIds.add(retraction.keyId);
    const supersededBy = attestations
      .filter((o) => o.supersedesAttestationId === a.attestationId)
      .map((o) => o.attestationId);
    return {
      attestationId: a.attestationId,
      statementHash: a.statementHash,
      issuer: {
        principalId: s.issuer.principalId,
        principalType: a.issuerPrincipalType,
        keyId: s.issuer.keyId,
      },
      claim: s.claim,
      subjectHash: s.subject.hash,
      ...opt('authorityContext', s.authorityContext),
      proof: {
        proofType: a.proofType,
        proofScheme: a.proofScheme,
        algorithm: a.algorithm,
        assurance: a.assurance,
        verifierId: a.verifierId,
        proofHash: a.proofHash,
      },
      signedAt: s.signedAt,
      expiresAt: s.expiresAt,
      issuedAt: ts(a.issuedAt),
      recordedAt: ts(a.recordedAt),
      ...opt('evidenceRefs', s.evidenceRefs),
      ...opt('supersedesAttestationId', a.supersedesAttestationId),
      ...opt('supersededBy', supersededBy.length === 0 ? undefined : supersededBy),
      ...opt(
        'retraction',
        retraction === undefined
          ? undefined
          : {
              retractionId: retraction.retractionId,
              statementHash: retraction.statementHash,
              keyId: retraction.keyId,
              proofHash: retraction.proofHash,
              reasonCode: retraction.reasonCode,
              issuedAt: ts(retraction.issuedAt),
              recordedAt: ts(retraction.recordedAt),
            },
      ),
    };
  });

  const keys = known(facts.keys)
    .filter((k) => keyIds.has(k.keyId))
    .map((k) => {
      const changes = known(facts.keyStatusChanges).filter((c) => c.keyId === k.keyId);
      return {
        keyId: k.keyId,
        principalId: k.principalId,
        factHash: k.factHash,
        verificationMaterialHash: k.verificationMaterialHash,
        keyKind: k.keyKind,
        algorithm: k.algorithm,
        effectiveFrom: ts(k.effectiveFrom),
        ...opt('effectiveTo', k.effectiveTo === undefined ? undefined : ts(k.effectiveTo)),
        ...opt(
          'statusChanges',
          changes.length === 0
            ? undefined
            : changes.map((c) => ({
                statusChangeId: c.statusChangeId,
                kind: c.kind,
                effectiveFrom: ts(c.effectiveFrom),
                recordedAt: ts(c.recordedAt),
                factHash: c.factHash,
              })),
        ),
      };
    });

  const doc = {
    asOf: ts(asOf),
    resultVersion: {
      resultVersionId: rv.resultVersionId,
      resultId: rv.resultId,
      versionNumber: rv.versionNumber,
      contentHash: rv.contentHash,
      contentSchema: rv.contentSchema,
      scope: {
        scopeType: rv.scope.scopeType,
        scopeTargetId: rv.scope.scopeTargetId,
        ...opt('competitionId', rv.scope.competitionId),
        ...opt('eventId', rv.scope.eventId),
        ...opt('roundId', rv.scope.roundId),
        ...opt('contestId', rv.scope.contestId),
        ...opt('sport', rv.scope.sport),
        ...opt('discipline', rv.scope.discipline),
        ...opt('region', rv.scope.region),
      },
    },
    evidence,
    attestations: attestationDocs,
    keys,
    lineage,
  };
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.evidenceBundle,
      SchemaRef.evidenceBundle.id,
      SchemaRef.evidenceBundle.version,
      doc,
    );
    return {
      bundle: r.normalized as Record<string, unknown>,
      bundleHash: r.contentHash,
      canonicalText: r.canonicalText,
    };
  } catch (err) {
    if (err instanceof CanonicalError)
      throw new DomainError(DomainErrorCode.INVALID_INPUT, `evidence bundle rejected: ${err.code}`);
    throw err;
  }
}
