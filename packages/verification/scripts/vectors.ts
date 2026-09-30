import { fileURLToPath } from 'node:url';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { evaluateVerification } from '../src/engine';
import { PRODUCTION_SUPPORTED_FACT_KINDS } from '@br/domain';
import {
  attestation,
  FIX,
  fixtureId,
  fixtureTime,
  produce,
  referenceCases,
  referenceWorld,
  withPolicySpec,
} from '../src/fixtures';
import { REFERENCE_POLICY_SPEC, type PolicySpec } from '../src/policy';
import { canonicalizeSnapshot, sealSnapshot, type VerificationSnapshot } from '../src/snapshot';

/**
 * BRT-07 verification vectors: canonical text + domain-separated hash of policies, snapshots,
 * outcomes and traces built from the synthetic REFERENCE ENGINE FIXTURES (never persisted sporting
 * truth). The independent Python checker re-derives JCS and every hash, checks equal / distinct
 * groups and the cross-bindings outcome → snapshotHash / traceHash / level.
 */
export const VECTORS_FILE = fileURLToPath(
  new URL('../test-vectors/brt-07.vectors.json', import.meta.url),
);

interface Vector {
  readonly name: string;
  readonly kind: 'policy' | 'snapshot' | 'outcome' | 'trace';
  readonly domainTag: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly canonicalText: string;
  readonly hash: string;
  readonly expectLevel?: string;
  readonly snapshotVector?: string;
  readonly traceVector?: string;
}

const REF = {
  policy: [DomainTag.verificationPolicy, SchemaRef.verificationPolicy],
  snapshot: [DomainTag.verificationSnapshot, SchemaRef.verificationSnapshot],
  outcome: [DomainTag.verificationOutcome, SchemaRef.verificationOutcome],
  trace: [DomainTag.verificationTrace, SchemaRef.verificationTrace],
} as const;

function vector(
  name: string,
  kind: Vector['kind'],
  doc: unknown,
  extra: Partial<Vector> = {},
): Vector {
  const [tag, schema] = REF[kind];
  const r = platformCanonicalizer().hashCanonical(tag, schema.id, schema.version, doc);
  return {
    name,
    kind,
    domainTag: tag,
    schemaId: schema.id,
    schemaVersion: schema.version,
    canonicalText: r.canonicalText,
    hash: r.contentHash,
    ...extra,
  };
}

const reversedKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? [...v].reverse().map(reversedKeys)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, reversedKeys(x)]),
        )
      : v;

export function generateBrt07Vectors() {
  const stricter: PolicySpec = {
    ...REFERENCE_POLICY_SPEC,
    levels: REFERENCE_POLICY_SPEC.levels.map((l) =>
      l.level === 'V1'
        ? {
            ...l,
            criteria: l.criteria.map((c) =>
              c.kind === 'INDEPENDENT_CORROBORATION' ? { ...c, params: { minIssuers: 2 } } : c,
            ),
          }
        : l,
    ),
  };
  const world = referenceWorld();
  const v1case = referenceCases().find((c) => c.name === 'v1-production-kinds')!.snapshot;
  const changed = produce(world, (d) => {
    d.attestations![0]!.issuedAt = '2026-03-01T10:01:00.000Z';
  });
  const otherPolicy = withPolicySpec(world, stricter);
  // V1 through a REGISTERED_OFFICIAL fact (no counterparty, no grant used): the official path.
  const registeredOfficial = produce(v1case, (d) => {
    d.supportedFactKinds = [...PRODUCTION_SUPPORTED_FACT_KINDS, 'REGISTERED_OFFICIAL'];
    d.attestations = [
      attestation('staff-referee-confirms', FIX.staffAdmin, 'PERSON', 'RESULT_ACCURATE', 60),
    ];
    d.registeredOfficials = [
      {
        registrationId: fixtureId('registration:staff-referee'),
        principalId: FIX.staffAdmin,
        subjectLevel: 'EVENT',
        subjectId: FIX.event,
        effectiveFrom: fixtureTime(0),
        recordedAt: fixtureTime(0),
      },
    ];
  });
  // Same facts sealed at two different cutoffs: the cutoff is metadata, so the hashes are equal.
  const sealedEarly = sealSnapshot(world, '2026-03-01T12:00:00.000Z');
  const sealedLate = sealSnapshot(world, '2027-01-01T00:00:00.000Z');
  if (sealedEarly.snapshotHash !== sealedLate.snapshotHash)
    throw new Error('cutoff leaked into the snapshot hash');

  const evalVectors = (name: string, s: VerificationSnapshot, level: string) => {
    const e = evaluateVerification(s);
    return [
      vector(`snapshot/${name}`, 'snapshot', canonicalizeSnapshot(s).snapshot),
      vector(`trace/${name}`, 'trace', e.trace),
      vector(`outcome/${name}`, 'outcome', e.outcome, {
        expectLevel: level,
        snapshotVector: `snapshot/${name}`,
        traceVector: `trace/${name}`,
      }),
    ];
  };
  const vectors: Vector[] = [
    vector('policy/reference', 'policy', REFERENCE_POLICY_SPEC),
    vector(
      'policy/reference-keys-and-sets-reordered',
      'policy',
      reversedKeys(REFERENCE_POLICY_SPEC),
    ),
    vector('policy/stricter-v2', 'policy', stricter),
    ...evalVectors('reference-world-v4', world, 'V4'),
    vector('snapshot/reference-world-reordered', 'snapshot', reversedKeys(world)),
    vector('snapshot/one-fact-changed', 'snapshot', changed),
    ...evalVectors('other-policy-min-two-issuers', otherPolicy, 'V0'),
    ...evalVectors('production-kinds-v1', v1case, 'V1'),
    ...evalVectors('registered-official-v1', registeredOfficial, 'V1'),
  ];
  return {
    schema: 'br-verification-vectors/1',
    note: 'REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. hash = SHA-256("BR"‖0x01‖domainTag‖0x00‖schemaId@version‖0x00‖"br-json/1"‖0x00‖JCS). The snapshot cutoff (asOf) is metadata: identical facts sealed at different cutoffs have the same snapshot hash.',
    fixtureIds: { resultVersion: FIX.resultVersion, policyVersion: FIX.policyVersion },
    cutoffIndependence: {
      early: sealedEarly.asOf,
      late: sealedLate.asOf,
      snapshotHash: sealedEarly.snapshotHash,
    },
    vectors,
    equal: [
      ['policy/reference', 'policy/reference-keys-and-sets-reordered'],
      ['snapshot/reference-world-v4', 'snapshot/reference-world-reordered'],
    ],
    distinct: [
      ['policy/reference', 'policy/stricter-v2'],
      [
        'snapshot/reference-world-v4',
        'snapshot/one-fact-changed',
        'snapshot/other-policy-min-two-issuers',
        'snapshot/production-kinds-v1',
        'snapshot/registered-official-v1',
      ],
      [
        'outcome/reference-world-v4',
        'outcome/other-policy-min-two-issuers',
        'outcome/production-kinds-v1',
        'outcome/registered-official-v1',
      ],
    ],
  };
}

export const serialize = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
