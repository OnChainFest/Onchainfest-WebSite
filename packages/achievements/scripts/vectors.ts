import { fileURLToPath } from 'node:url';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';
import { deriveAchievements, identityOf } from '../src/engine';
import {
  FIXTURE_RULES,
  FX,
  padelTitleFixture,
  personalBestFixture,
  thresholdFixture,
} from '../src/fixtures';
import type { AchievementDerivationSnapshot } from '../src/snapshot';

/**
 * BRT-08 achievement vectors: canonical text + domain-separated hash of rules, derivation
 * snapshots, derivation outcomes, candidates and identities built from REFERENCE ENGINE FIXTURES
 * (never persisted sporting truth). The independent Python checker re-derives JCS and every hash,
 * checks equal / distinct groups and the bindings outcome → snapshotHash and outcome → candidate /
 * identity hashes.
 */
export const VECTORS_FILE = fileURLToPath(
  new URL('../test-vectors/brt-08.vectors.json', import.meta.url),
);

type Kind = 'rule' | 'snapshot' | 'outcome' | 'candidate' | 'identity' | 'evidenceCommitment';
interface Vector {
  readonly name: string;
  readonly kind: Kind;
  readonly domainTag: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly canonicalText: string;
  readonly hash: string;
  readonly snapshotVector?: string;
  readonly candidateVectors?: readonly string[];
  readonly identityVectors?: readonly string[];
  readonly commitmentVectors?: readonly string[];
  readonly expectState?: string;
}

const REF = {
  rule: [DomainTag.achievementRule, SchemaRef.achievementRule],
  snapshot: [DomainTag.achievementDerivationSnapshot, SchemaRef.achievementDerivationSnapshot],
  outcome: [DomainTag.achievementDerivationOutcome, SchemaRef.achievementDerivationOutcome],
  candidate: [DomainTag.achievementCandidate, SchemaRef.achievementCandidate],
  identity: [DomainTag.achievementIdentity, SchemaRef.achievementIdentity],
  evidenceCommitment: [
    DomainTag.achievementEvidenceCommitment,
    SchemaRef.achievementEvidenceCommitment,
  ],
} as const;

function vector(name: string, kind: Kind, doc: unknown, extra: Partial<Vector> = {}): Vector {
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

const reversed = (v: unknown): unknown =>
  Array.isArray(v)
    ? [...v].reverse().map(reversed)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .reverse()
            .map(([k, x]) => [k, reversed(x)]),
        )
      : v;

export function generateBrt08Vectors() {
  const derived = (name: string, s: AchievementDerivationSnapshot) => {
    const d = deriveAchievements(s);
    const cs = d.outcome.candidates ?? [];
    const candidateVectors = cs.map((c, i) =>
      vector(`candidate/${name}/${i}`, 'candidate', c.candidate),
    );
    const identityVectors = cs.map((c, i) =>
      vector(`identity/${name}/${i}`, 'identity', identityOf(c.candidate).identity),
    );
    const commitmentVectors = cs.map((c, i) =>
      vector(`evidence-commitment/${name}/${i}`, 'evidenceCommitment', {
        basis: c.candidate.basis.map((b) => ({
          resultVersionId: b.resultVersionId,
          contentHash: b.contentHash,
          verificationRunId: b.verificationRunId,
          evidenceBundleHash: b.evidenceBundleHash,
          evidenceBundleAsOf: b.evidenceBundleAsOf,
        })),
      }),
    );
    return [
      vector(`snapshot/${name}`, 'snapshot', s),
      vector(`outcome/${name}`, 'outcome', d.outcome, {
        snapshotVector: `snapshot/${name}`,
        candidateVectors: candidateVectors.map((v) => v.name),
        identityVectors: identityVectors.map((v) => v.name),
        commitmentVectors: commitmentVectors.map((v) => v.name),
        expectState: d.outcome.state,
      }),
      ...candidateVectors,
      ...identityVectors,
      ...commitmentVectors,
    ];
  };
  const title = padelTitleFixture();
  const vectors: Vector[] = [
    vector('rule/reference-title', 'rule', FIXTURE_RULES.padelTitle),
    vector('rule/reference-title-reordered', 'rule', reversed(FIXTURE_RULES.padelTitle)),
    vector('rule/perfect-game', 'rule', FIXTURE_RULES.perfectGame),
    ...derived('team-title-v2', title),
    vector('snapshot/team-title-reordered', 'snapshot', reversed(title)),
    ...derived('team-title-v1-blocked', padelTitleFixture({ level: 'V1' })),
    ...derived(
      'team-title-other-lineup',
      padelTitleFixture({ lineupA: [FX.athleteA1, FX.unusedRosterAthlete] }),
    ),
    ...derived(
      'national-title-v3-sanction',
      padelTitleFixture({
        level: 'V3',
        sport: 'padel',
        recognition: {
          level: 'NATIONAL',
          source: 'SANCTION',
          scope: { recognitionLevel: ['NATIONAL'], sport: ['padel'], region: ['CR'] },
        },
        ruleLabel: 'national-title',
        ruleSpec: {
          ...FIXTURE_RULES.padelTitle,
          displayName: 'National Champion',
          requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
          criterion: {
            ...FIXTURE_RULES.padelTitle.criterion,
            recognitionClaim: { level: 'NATIONAL', region: ['CR'] },
          },
        },
      }),
    ),
    ...derived(
      'national-title-platform-blocked',
      padelTitleFixture({
        level: 'V3',
        sport: 'padel',
        recognition: { level: 'PLATFORM' },
        ruleLabel: 'national-title',
        ruleSpec: {
          ...FIXTURE_RULES.padelTitle,
          displayName: 'National Champion',
          requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
          criterion: {
            ...FIXTURE_RULES.padelTitle.criterion,
            recognitionClaim: { level: 'NATIONAL', region: ['CR'] },
          },
        },
      }),
    ),
    ...derived(
      'national-title-v3-wrong-region',
      padelTitleFixture({
        level: 'V3',
        sport: 'padel',
        recognition: {
          level: 'NATIONAL',
          source: 'SANCTION',
          scope: { recognitionLevel: ['NATIONAL'], sport: ['padel'], region: ['PE'] },
        },
        ruleLabel: 'national-title',
        ruleSpec: {
          ...FIXTURE_RULES.padelTitle,
          displayName: 'National Champion',
          requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
          criterion: {
            ...FIXTURE_RULES.padelTitle.criterion,
            recognitionClaim: { level: 'NATIONAL', region: ['CR'] },
          },
        },
      }),
    ),
    ...derived('perfect-game', thresholdFixture()),
    ...derived(
      'running-pb',
      personalBestFixture({
        kind: 'RUNNING',
        value: '1190000',
        priors: [{ value: '1200000', minute: 1 }],
      }),
    ),
  ];
  return {
    schema: 'br-achievement-vectors/1',
    note: 'REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. hash = SHA-256("BR"‖0x01‖domainTag‖0x00‖schemaId@version‖0x00‖"br-json/1"‖0x00‖JCS). A team title is ONE TEAM candidate with memberCredits (BRT-01 §8.1, AC-5).',
    vectors,
    equal: [
      ['rule/reference-title', 'rule/reference-title-reordered'],
      ['snapshot/team-title-v2', 'snapshot/team-title-reordered'],
    ],
    distinct: [
      ['rule/reference-title', 'rule/perfect-game'],
      [
        'snapshot/team-title-v2',
        'snapshot/team-title-v1-blocked',
        'snapshot/team-title-other-lineup',
      ],
      ['snapshot/national-title-v3-sanction', 'snapshot/national-title-v3-wrong-region'],
      ['candidate/team-title-v2/0', 'candidate/team-title-other-lineup/0'],
      ['identity/team-title-v2/0', 'identity/team-title-other-lineup/0'],
    ],
  };
}

export const serialize = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
