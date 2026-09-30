import { createHash } from 'node:crypto';
import {
  ALL_CANONICAL_FACT_KINDS,
  PRODUCTION_SUPPORTED_FACT_KINDS,
  type CanonicalFactKind,
  type Capability,
  type PrincipalType,
  type Uuid,
  type RecognitionLevel,
  type VerificationLevel,
} from '@br/domain';
import {
  REFERENCE_POLICY_CODE,
  REFERENCE_POLICY_SPEC,
  validatePolicySpec,
  type PolicySpec,
} from './policy';
import type {
  SignedFact,
  SnapshotAttestation,
  SnapshotAuthority,
  VerificationSnapshot,
} from './snapshot';

/**
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH.
 *
 * Typed, in-memory, fully synthetic VerificationSnapshots that exercise the exact V2/V3/V4 criteria
 * whose canonical producers (RESULT_OFFICIAL, T5, COMPETITION_SANCTIONED, IDENTITY_CONFIRMED,
 * official evidence set, EvidenceAssessment, record category, RECORD_RATIFIED / REVIEW_COMPLETED)
 * do not exist in the platform yet. Every fixture snapshot carries
 * `provenance: REFERENCE_FIXTURE`; persistence accepts only `CANONICAL_ASSEMBLY` snapshots it
 * assembled itself (and a database CHECK refuses anything else), so these can never become runs.
 *
 * Ids are deterministic (derived from labels) so fixture hashes are stable across runs; no clock,
 * randomness, database or environment is involved. They are NOT exported from the package root —
 * import them explicitly from `@br/verification/fixtures` (tests and the demo's Part B only).
 */
export const FIXTURE_LABEL = 'REFERENCE ENGINE FIXTURE — not persisted sporting truth';

/** Deterministic UUID (v8 layout) from a label. */
export function fixtureId(label: string): string {
  const h = createHash('sha256').update(`br-verification-fixture:${label}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const hash = (label: string) =>
  `sha256:${createHash('sha256').update(`br-verification-fixture-hash:${label}`).digest('hex')}`;
const T0 = Date.parse('2026-03-01T09:00:00.000Z');
export const fixtureTime = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

export const FIX = {
  competition: fixtureId('competition'),
  event: fixtureId('event'),
  round: fixtureId('round'),
  contest: fixtureId('contest'),
  siblingCompetition: fixtureId('sibling-competition'),
  result: fixtureId('result'),
  resultVersion: fixtureId('result-version'),
  participantA: fixtureId('participant-a'),
  participantB: fixtureId('participant-b'),
  athleteA: fixtureId('athlete-a'),
  athleteB: fixtureId('athlete-b'),
  // principals
  platform: fixtureId('platform'),
  federation: fixtureId('federation'),
  organizer: fixtureId('organizer-org'),
  official: fixtureId('official'),
  platformOfficial: fixtureId('platform-official'),
  sanctioner: fixtureId('sanctioner'),
  technical: fixtureId('technical-official'),
  ratifier: fixtureId('ratifier'),
  timingSystem: fixtureId('timing-system'),
  staffAdmin: fixtureId('staff-admin'),
  athletePrincipalA: fixtureId('athlete-principal-a'),
  athletePrincipalB: fixtureId('athlete-principal-b'),
  // anchors / grants / keys
  platformAnchor: fixtureId('anchor-platform'),
  federationAnchor: fixtureId('anchor-federation'),
  recordCategory: fixtureId('record-category'),
  policy: fixtureId('policy'),
  policyVersion: fixtureId('policy-version'),
} as const;
export const keyOf = (principal: string, n = 1) => fixtureId(`key:${principal}:${n}`);

const SPORT = 'padel';
const DISCIPLINE = 'padel.doubles';
const REGION = 'CR';

function grant(
  label: string,
  grantor: string,
  grantee: string,
  capabilities: Capability[],
  level: RecognitionLevel,
  opts: { competition?: string; from?: number; to?: number; recordedAt?: number } = {},
): NonNullable<SnapshotAuthority['grants']>[number] {
  const recordedAt = opts.recordedAt ?? opts.from ?? 0;
  return {
    grantId: fixtureId(`grant:${label}`),
    grantorPrincipalId: grantor,
    granteePrincipalId: grantee,
    capabilities,
    scope: {
      ...(level === 'PLATFORM' ? {} : { sport: [SPORT], region: [REGION] }),
      recognitionLevel: [level],
      competition: [(opts.competition ?? FIX.competition) as Uuid],
    },
    delegation: { allowed: false, maxDepth: 0 },
    grantHash: hash(`grant:${label}`),
    effectiveFrom: fixtureTime(opts.from ?? 0),
    ...(opts.to === undefined ? {} : { effectiveTo: fixtureTime(opts.to) }),
    recordedAt: fixtureTime(recordedAt),
  };
}

export function signed(
  label: string,
  issuer: string,
  issuerType: SignedFact['issuerPrincipalType'],
  minutes: number,
  extra: Partial<SignedFact> = {},
): SignedFact {
  return {
    attestationId: fixtureId(`fact:${label}`),
    statementHash: hash(`statement:${label}`),
    issuerPrincipalId: issuer,
    issuerPrincipalType: issuerType,
    keyId: keyOf(issuer),
    assurance: 'HOLDER_KEY',
    issuedAt: fixtureTime(minutes),
    signedAt: fixtureTime(minutes),
    proof: 'VERIFIED',
    polarity: 'AFFIRM',
    status: 'ACTIVE',
    ...extra,
  };
}

export function attestation(
  label: string,
  issuer: string,
  issuerType: SignedFact['issuerPrincipalType'],
  claimType: SnapshotAttestation['claimType'],
  minutes: number,
  extra: Partial<SnapshotAttestation> = {},
): Mutable<SnapshotAttestation> {
  return {
    ...signed(label, issuer, issuerType, minutes),
    claimType,
    ...extra,
  } as Mutable<SnapshotAttestation>;
}

const policyHash = (spec: PolicySpec) => {
  const v = validatePolicySpec(spec);
  if (!v.ok) throw new Error(`fixture policy invalid: ${JSON.stringify(v.issues)}`);
  return v.specHash;
};

/**
 * The complete reference world: every BRT-01 fact needed for V4 on a national-level padel record.
 * Individual scenarios remove or alter facts from it.
 */
export function referenceWorld(spec: PolicySpec = REFERENCE_POLICY_SPEC): VerificationSnapshot {
  const signers: [string, PrincipalType][] = [
    [FIX.platform, 'PLATFORM'],
    [FIX.federation, 'ORGANIZATION'],
    [FIX.organizer, 'ORGANIZATION'],
    [FIX.official, 'PERSON'],
    [FIX.platformOfficial, 'PERSON'],
    [FIX.sanctioner, 'PERSON'],
    [FIX.technical, 'PERSON'],
    [FIX.ratifier, 'PERSON'],
    [FIX.timingSystem, 'SYSTEM'],
    [FIX.staffAdmin, 'PERSON'],
    [FIX.athletePrincipalA, 'PERSON'],
    [FIX.athletePrincipalB, 'PERSON'],
  ];
  const key = (principalId: string, n = 1) => ({
    keyId: keyOf(principalId, n),
    principalId,
    keyKind: 'JWK' as const,
    algorithm: 'EdDSA' as const,
    factHash: hash(`key:${principalId}:${n}`),
    effectiveFrom: fixtureTime(0),
    recordedAt: fixtureTime(0),
  });
  return {
    provenance: 'REFERENCE_FIXTURE',
    assembler: 'reference-fixture/1',
    policy: {
      policyId: FIX.policy,
      policyVersionId: FIX.policyVersion,
      code: REFERENCE_POLICY_CODE,
      version: 1,
      specHash: policyHash(spec),
      spec,
    },
    resultVersion: {
      resultVersionId: FIX.resultVersion,
      resultId: FIX.result,
      versionNumber: 1,
      contentHash: hash('content'),
      contentSchema: 'br:result-version-content@1',
      submittedByPrincipalId: FIX.athletePrincipalA,
      submittedAt: fixtureTime(30),
      status: 'SUBMITTED',
      scopeType: 'CONTEST',
      scopeTargetId: FIX.contest,
      entryParticipantIds: [FIX.participantA, FIX.participantB],
    },
    hierarchy: {
      level: 'CONTEST',
      competitionId: FIX.competition,
      eventId: FIX.event,
      roundId: FIX.round,
      contestId: FIX.contest,
      sport: SPORT,
      discipline: DISCIPLINE,
      region: REGION,
    },
    discipline: {
      disciplineVersionId: fixtureId('discipline-version'),
      primaryEvidenceTypes: ['SIGNED_SCORESHEET', 'TIMING_SYSTEM_EXPORT'],
    },
    evidence: [
      {
        evidenceId: fixtureId('ev-scoresheet'),
        evidenceType: 'SIGNED_SCORESHEET',
        contentHash: hash('ev-scoresheet-bytes'),
        descriptorHash: hash('ev-scoresheet'),
        sourceKind: 'HUMAN',
        sourcePrincipalId: FIX.official,
        availability: 'AVAILABLE',
        versionRoles: ['PRIMARY'],
        provenanceRootId: fixtureId('ev-scoresheet'),
        integrity: 'VERIFIED',
      },
      {
        evidenceId: fixtureId('ev-timing'),
        evidenceType: 'TIMING_SYSTEM_EXPORT',
        contentHash: hash('ev-timing-bytes'),
        descriptorHash: hash('ev-timing'),
        sourceKind: 'TIMING_SYSTEM',
        sourcePrincipalId: FIX.timingSystem,
        availability: 'AVAILABLE',
        versionRoles: ['PRIMARY'],
        provenanceRootId: fixtureId('ev-timing'),
        integrity: 'VERIFIED',
      },
    ],
    attestations: [
      attestation('b-confirms', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 60),
      attestation('official-declares', FIX.official, 'PERSON', 'RESULT_OFFICIAL', 70, {
        evidenceIds: [fixtureId('ev-scoresheet')],
      }),
      attestation('conditions', FIX.technical, 'PERSON', 'CONDITIONS_COMPLIANT', 75, {
        conditionAspects: ['WIND', 'TIMING_SYSTEM'],
      }),
    ],
    sanctions: [
      {
        ...signed('sanction', FIX.sanctioner, 'PERSON', 5),
        subjectLevel: 'EVENT',
        subjectId: FIX.event,
        recognitionLevel: 'NATIONAL',
      },
    ],
    identityConfirmations: [
      { ...signed('identity-a', FIX.official, 'PERSON', 20), athleteId: FIX.athleteA },
      { ...signed('identity-b', FIX.official, 'PERSON', 21), athleteId: FIX.athleteB },
    ],
    ratifications: [
      {
        ...signed('ratification', FIX.ratifier, 'PERSON', 120),
        kind: 'RECORD_RATIFIED',
        recordCategoryId: FIX.recordCategory,
      },
    ],
    officialEvidenceSet: { evidenceTypes: ['SIGNED_SCORESHEET', 'TIMING_SYSTEM_EXPORT'] },
    recordCategory: {
      recordCategoryId: FIX.recordCategory,
      recognitionLevel: 'NATIONAL',
      requiredConditionAspects: ['WIND'],
    },
    evidenceAssessments: [],
    supportedFactKinds: [...ALL_CANONICAL_FACT_KINDS],
    keys: [
      ...signers.map(([p]) => key(p)),
      key(FIX.athletePrincipalB, 2), // a second key of the same principal (still ONE issuer)
    ],
    authority: {
      principals: signers.map(([principalId, principalType]) => ({
        principalId,
        principalType,
        recordedAt: fixtureTime(0),
      })),
      anchors: [
        {
          anchorId: FIX.platformAnchor,
          principalId: FIX.platform,
          recognitionScope: { recognitionLevel: ['PLATFORM'] },
          factHash: hash('anchor-platform'),
          effectiveFrom: fixtureTime(0),
          recordedAt: fixtureTime(0),
        },
        {
          anchorId: FIX.federationAnchor,
          principalId: FIX.federation,
          recognitionScope: { sport: [SPORT], region: [REGION], recognitionLevel: ['NATIONAL'] },
          factHash: hash('anchor-federation'),
          effectiveFrom: fixtureTime(0),
          recordedAt: fixtureTime(0),
        },
      ],
      grants: [
        grant(
          'official',
          FIX.federation,
          FIX.official,
          ['ATTEST_IDENTITY', 'ATTEST_RESULT', 'DECLARE_OFFICIAL'],
          'NATIONAL',
        ),
        grant(
          'platform-official',
          FIX.platform,
          FIX.platformOfficial,
          ['ATTEST_RESULT', 'DECLARE_OFFICIAL'],
          'PLATFORM',
        ),
        grant('sanctioner', FIX.federation, FIX.sanctioner, ['SANCTION'], 'NATIONAL'),
        grant('technical', FIX.federation, FIX.technical, ['ATTEST_CONDITIONS'], 'NATIONAL'),
        grant('ratifier', FIX.federation, FIX.ratifier, ['RATIFY_RECORD'], 'NATIONAL'),
      ],
    },
    participation: {
      sidesComplete: true,
      sides: [
        {
          participantId: FIX.participantA,
          participantKind: 'INDIVIDUAL',
          athleteIds: [FIX.athleteA],
          principalIds: [FIX.athletePrincipalA],
        },
        {
          participantId: FIX.participantB,
          participantKind: 'INDIVIDUAL',
          athleteIds: [FIX.athleteB],
          principalIds: [FIX.athletePrincipalB],
        },
      ],
      principals: [
        ...signers
          .filter(
            ([p]) =>
              p !== FIX.athletePrincipalA &&
              p !== FIX.athletePrincipalB &&
              p !== FIX.organizer &&
              p !== FIX.staffAdmin,
          )
          .map(([principalId, principalType]) => ({
            principalId,
            principalType,
            resolution: 'RESOLVED' as const,
          })),
        {
          principalId: FIX.organizer,
          principalType: 'ORGANIZATION',
          resolution: 'RESOLVED',
          relations: [{ kind: 'ORGANIZER_ORGANIZATION', timing: 'STRUCTURAL' }],
        },
        {
          principalId: FIX.staffAdmin,
          principalType: 'PERSON',
          resolution: 'RESOLVED',
          relations: [{ kind: 'COMPETITION_STAFF', timing: 'DURING_OCCURRENCE' }],
        },
        {
          principalId: FIX.athletePrincipalA,
          principalType: 'PERSON',
          resolution: 'RESOLVED',
          relations: [
            { kind: 'SELF_PARTICIPANT', participantId: FIX.participantA, timing: 'STRUCTURAL' },
          ],
        },
        {
          principalId: FIX.athletePrincipalB,
          principalType: 'PERSON',
          resolution: 'RESOLVED',
          relations: [
            { kind: 'SELF_PARTICIPANT', participantId: FIX.participantB, timing: 'STRUCTURAL' },
          ],
        },
      ],
    },
  };
}

type Mutable<T> = T extends string | number | boolean
  ? T
  : T extends readonly (infer U)[]
    ? Mutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
export type DraftSnapshot = Mutable<VerificationSnapshot>;

/** Structured clone + in-place mutation (fixture authoring only). */
export function produce(
  base: VerificationSnapshot,
  mutate: (draft: DraftSnapshot) => void,
): VerificationSnapshot {
  const draft = structuredClone(base) as DraftSnapshot;
  mutate(draft);
  return draft as VerificationSnapshot;
}

/** Replaces the snapshot's policy spec and re-seals its hash (fixture authoring only). */
export function withPolicySpec(base: VerificationSnapshot, spec: PolicySpec): VerificationSnapshot {
  return produce(base, (d) => {
    d.policy.spec = structuredClone(spec) as DraftSnapshot['policy']['spec'];
    d.policy.specHash = policyHash(spec);
  });
}

const without = (draft: DraftSnapshot, ...keys: (keyof VerificationSnapshot)[]) => {
  for (const k of keys) delete (draft as Record<string, unknown>)[k];
};
const supportOnly = (draft: DraftSnapshot, kinds: readonly CanonicalFactKind[]) => {
  draft.supportedFactKinds = [...kinds];
};

export interface ReferenceCase {
  readonly name: string;
  readonly description: string;
  readonly expectedLevel: VerificationLevel;
  readonly snapshot: VerificationSnapshot;
}

/** Named reference cases (pass AND blocked variants for V2, V3 and V4). */
export function referenceCases(): ReferenceCase[] {
  const world = referenceWorld();
  const v2Only = (d: DraftSnapshot) => {
    d.sanctions = [];
    d.ratifications = [];
    without(d, 'recordCategory');
  };
  return [
    {
      name: 'v1-production-kinds',
      description:
        "Only today's producible fact kinds: V2 blocked by missing RESULT_OFFICIAL / T5 producers",
      expectedLevel: 'V1',
      snapshot: produce(world, (d) => supportOnly(d, PRODUCTION_SUPPORTED_FACT_KINDS)),
    },
    {
      name: 'v2-result-official',
      description:
        'RESULT_OFFICIAL by an ATTEST_RESULT/DECLARE_OFFICIAL chain + primary evidence (no sanction)',
      expectedLevel: 'V2',
      snapshot: produce(world, v2Only),
    },
    {
      name: 'v2-accurate-plus-t5',
      description:
        'RESULT_ACCURATE by the official + an authorized T5 (PROVISIONAL → OFFICIAL) record',
      expectedLevel: 'V2',
      snapshot: produce(world, (d) => {
        v2Only(d);
        d.attestations = (d.attestations ?? []).map((a) =>
          a.claimType === 'RESULT_OFFICIAL' ? { ...a, claimType: 'RESULT_ACCURATE' } : a,
        );
        d.t5Transitions = [
          {
            transitionId: fixtureId('t5'),
            actorPrincipalId: FIX.official,
            recordedAt: fixtureTime(80),
          },
        ];
      }),
    },
    {
      name: 'v2-blocked-accurate-without-t5',
      description:
        'An authorized RESULT_ACCURATE alone is NOT an official declaration (no T5, no RESULT_OFFICIAL)',
      expectedLevel: 'V1',
      snapshot: produce(world, (d) => {
        v2Only(d);
        d.attestations = (d.attestations ?? []).map((a) =>
          a.claimType === 'RESULT_OFFICIAL' ? { ...a, claimType: 'RESULT_ACCURATE' } : a,
        );
      }),
    },
    {
      name: 'v3-sanctioned',
      description:
        'National sanction + certification rooted in the sanctioning anchor + official evidence set + identity',
      expectedLevel: 'V3',
      snapshot: produce(world, (d) => {
        d.ratifications = [];
      }),
    },
    {
      name: 'v3-blocked-missing-identity',
      description: 'Everything for V3 except IDENTITY_CONFIRMED',
      expectedLevel: 'V2',
      snapshot: produce(world, (d) => {
        d.ratifications = [];
        d.identityConfirmations = [];
      }),
    },
    {
      name: 'v4-ratified',
      description:
        'V3 + authorized conditions + two independent primary sources + non-witnessed signatures + national ratification',
      expectedLevel: 'V4',
      snapshot: world,
    },
    {
      name: 'v4-blocked-missing-ratification',
      description: 'Everything for V4 except RECORD_RATIFIED / REVIEW_COMPLETED',
      expectedLevel: 'V3',
      snapshot: produce(world, (d) => {
        d.ratifications = [];
      }),
    },
  ];
}
