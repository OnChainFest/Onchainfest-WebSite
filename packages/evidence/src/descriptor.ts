import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  ACCEPTED_CAPTURED_AT_ASSURANCE,
  DomainError,
  DomainErrorCode,
  SIGNER_CLOCK_SKEW_MS,
  toCanonicalTimestamp,
  type AcquisitionMethod,
  type CapturedAtAssurance,
  type EvidenceMediaType,
  type EvidenceRelationKind,
  type EvidenceSourceKind,
  type EvidenceType,
  type GeneratorKind,
  type Instant,
  type Uuid,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

/**
 * EvidenceDescriptor (`br:evidence-descriptor@1`): the canonical, versioned commitment of ONE
 * EvidenceItem to exact bytes (server-computed SHA-256, length, media type) and to its provenance.
 *
 *   descriptorHash = SHA-256("BR" ‖ 0x01 ‖ "evidence-descriptor" ‖ 0x00 ‖
 *                            "br:evidence-descriptor@1" ‖ 0x00 ‖ "br-json/1" ‖ 0x00 ‖ JCS(descriptor))
 *
 * Same semantic descriptor → same canonical bytes → same hash (member order, set order and
 * Unicode form are normalized by BR-JSON). The bytes' own hash (`content.sha256`) is the plain
 * SHA-256 of the raw bytes, so anyone can check a file with `sha256sum` (ADR-0014 exception).
 *
 * A descriptor records what was RECEIVED and from WHOM. It asserts nothing about the sporting
 * occurrence: evidence ≠ attestation ≠ truth (ADR-0002).
 */
export interface EvidenceSourceInput {
  readonly kind: EvidenceSourceKind;
  readonly principalId?: Uuid;
  readonly system?: { readonly id: string; readonly version: string };
  readonly deviceId?: string;
  /** Private external identifiers stay internal (never in public DTOs). */
  readonly externalNamespace?: string;
  readonly externalId?: string;
  /** Source assertion only (BRT-02 §5.1). */
  readonly capturedAt?: Instant;
  readonly capturedAtAssurance?: CapturedAtAssurance;
}

export interface DerivationInput {
  readonly generator: {
    readonly kind: GeneratorKind;
    readonly systemId: string;
    readonly version: string;
    readonly configurationHash?: string;
  };
  readonly generatedAt?: Instant;
  readonly inputs: readonly { readonly evidenceId: Uuid; readonly contentHash: string }[];
}

export interface LineageEdgeInput {
  readonly relation: EvidenceRelationKind;
  readonly evidenceId: Uuid;
  readonly descriptorHash: string;
}

export interface EvidenceDescriptorInput {
  readonly evidenceId: Uuid;
  readonly evidenceType: EvidenceType;
  /** Computed by the storage layer from the exact bytes — never taken from the client. */
  readonly contentHash: ContentHash;
  readonly byteLength: number;
  readonly mediaType: EvidenceMediaType;
  readonly source: EvidenceSourceInput;
  readonly acquisition: { readonly method: AcquisitionMethod; readonly receivedAt: Instant };
  readonly derivation?: DerivationInput;
  readonly lineage?: readonly LineageEdgeInput[];
}

export interface EvidenceDescriptor {
  readonly evidenceId: string;
  readonly evidenceType: EvidenceType;
  readonly content: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly mediaType: string;
  };
  readonly source: Record<string, unknown> & {
    readonly kind: EvidenceSourceKind;
    readonly capturedAtAssurance: CapturedAtAssurance;
  };
  readonly acquisition: { readonly method: AcquisitionMethod; readonly receivedAt: string };
  readonly derivation?: Record<string, unknown>;
  readonly lineage?: readonly { relation: string; evidenceId: string; descriptorHash: string }[];
}

export interface HashedDescriptor {
  readonly descriptor: EvidenceDescriptor;
  readonly descriptorHash: ContentHash;
  readonly canonicalText: string;
}

const invalid = (message: string) => new DomainError(DomainErrorCode.INVALID_INPUT, message);

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>);

/** Builds the descriptor document (not yet normalized) from typed input, enforcing BRT-01 rules. */
export function descriptorDocument(input: EvidenceDescriptorInput): Record<string, unknown> {
  const s = input.source;
  const assurance = s.capturedAtAssurance ?? 'SOURCE_CLAIMED';
  if (!ACCEPTED_CAPTURED_AT_ASSURANCE.includes(assurance)) {
    throw invalid(
      'capturedAtAssurance other than SOURCE_CLAIMED needs device/timestamp verification (not available yet)',
    );
  }
  // BRT-02 §5.1 rule 7: an externally supplied clock may not claim a time after the platform saw
  // the bytes (the existing signer/device skew tolerance applies; no new slack is introduced).
  if (
    s.capturedAt !== undefined &&
    s.capturedAt.getTime() > input.acquisition.receivedAt.getTime() + SIGNER_CLOCK_SKEW_MS
  ) {
    throw invalid('capturedAt cannot be after the platform received the evidence');
  }
  if ((s.externalNamespace === undefined) !== (s.externalId === undefined)) {
    throw invalid('externalNamespace and externalId go together');
  }
  // BRT-01 E-4: AI-derived evidence must reference its source media and its pipeline version.
  if (input.evidenceType === 'AI_DERIVED' || s.kind === 'AI_PIPELINE') {
    if (input.derivation === undefined || input.derivation.inputs.length === 0) {
      throw invalid('AI-derived evidence must declare its generator and input evidence');
    }
  }
  const lineage = input.lineage ?? [];
  if (lineage.some((l) => l.evidenceId === input.evidenceId)) {
    throw invalid('evidence cannot be its own lineage parent');
  }
  for (const i of input.derivation?.inputs ?? []) {
    if (!lineage.some((l) => l.evidenceId === i.evidenceId)) {
      throw invalid('every derivation input must also be a lineage parent');
    }
  }
  const d = input.derivation;
  return {
    evidenceId: input.evidenceId,
    evidenceType: input.evidenceType,
    content: {
      sha256: input.contentHash,
      byteLength: input.byteLength,
      mediaType: input.mediaType,
    },
    source: {
      kind: s.kind,
      ...optional('principalId', s.principalId),
      ...optional('system', s.system),
      ...optional('deviceId', s.deviceId),
      ...optional('externalNamespace', s.externalNamespace),
      ...optional('externalId', s.externalId),
      ...optional(
        'capturedAt',
        s.capturedAt === undefined ? undefined : toCanonicalTimestamp(s.capturedAt),
      ),
      capturedAtAssurance: assurance,
    },
    acquisition: {
      method: input.acquisition.method,
      receivedAt: toCanonicalTimestamp(input.acquisition.receivedAt),
    },
    ...optional(
      'derivation',
      d === undefined
        ? undefined
        : {
            generator: {
              kind: d.generator.kind,
              systemId: d.generator.systemId,
              version: d.generator.version,
              ...optional('configurationHash', d.generator.configurationHash),
            },
            ...optional(
              'generatedAt',
              d.generatedAt === undefined ? undefined : toCanonicalTimestamp(d.generatedAt),
            ),
            inputs: d.inputs.map((i) => ({ evidenceId: i.evidenceId, contentHash: i.contentHash })),
          },
    ),
    ...optional(
      'lineage',
      lineage.length === 0
        ? undefined
        : lineage.map((l) => ({
            relation: l.relation,
            evidenceId: l.evidenceId,
            descriptorHash: l.descriptorHash,
          })),
    ),
  };
}

/** Canonicalizes and hashes a descriptor document (already-built or from storage). */
export function hashDescriptorDocument(doc: unknown): HashedDescriptor {
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.evidenceDescriptor,
      SchemaRef.evidenceDescriptor.id,
      SchemaRef.evidenceDescriptor.version,
      doc,
    );
    return {
      descriptor: r.normalized as unknown as EvidenceDescriptor,
      descriptorHash: r.contentHash,
      canonicalText: r.canonicalText,
    };
  } catch (err) {
    if (err instanceof CanonicalError) throw invalid(`evidence descriptor rejected: ${err.code}`);
    throw err;
  }
}

export function buildEvidenceDescriptor(input: EvidenceDescriptorInput): HashedDescriptor {
  return hashDescriptorDocument(descriptorDocument(input));
}
