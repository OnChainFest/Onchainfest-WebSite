import { CanonicalError, type ContentHash } from '@br/canonical';
import {
  type Capability,
  type CriterionKind,
  type ParticipationRelation,
  type RecognitionLevel,
  type VerificationLevel,
  VERIFICATION_LEVELS,
} from '@br/domain';
import { DomainTag, platformCanonicalizer, SchemaRef } from '@br/schemas';

/**
 * Declarative verification policy (`br:verification-policy@1`, BRT-07 §9–17).
 *
 * A policy is DATA: for each level, a conjunctive list of criteria drawn from a closed vocabulary,
 * each with bounded parameters. There is no expression language, script, SQL, plugin or nested
 * boolean tree. A policy may RAISE BRT-01's requirements (higher counts, stricter options, extra
 * NO_ACTIVE_DISPUTE criteria, extra conflict relations) but can never lower them: every defined
 * level must contain BRT-01's mandatory criteria for that level, levels must form an unbroken
 * chain from V0, and structural invariants (E-4 AI-only ceiling, platform recognition ceiling,
 * rule-7 conflicts, V4 non-witnessed signatures) live in the engine, out of the policy's reach.
 */
export const ENGINE_ID = 'bragging-rights-verification-engine';
export const ENGINE_VERSION = 'verification-engine/1';
export const SUPPORTED_ENGINE_VERSIONS: readonly string[] = [ENGINE_VERSION];

export interface CriterionParams {
  readonly minIssuers?: number;
  readonly minItems?: number;
  readonly minSources?: number;
  readonly capabilities?: readonly Capability[];
  readonly availability?: readonly ('AVAILABLE' | 'ARCHIVED')[];
  readonly minRecognitionLevel?: Extract<
    RecognitionLevel,
    'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD'
  >;
}

export interface PolicyCriterion {
  readonly id: string;
  readonly kind: CriterionKind;
  readonly params?: CriterionParams;
}

export interface PolicyLevel {
  readonly level: VerificationLevel;
  readonly requiresPreviousLevel: boolean;
  readonly criteria: readonly PolicyCriterion[];
}

export interface PolicySpec {
  readonly targetEngine: string;
  readonly levels: readonly PolicyLevel[];
  readonly conflict?: {
    readonly additionalProhibitedRelations?: readonly ParticipationRelation[];
  };
}

/** The level each criterion kind belongs to (NO_ACTIVE_DISPUTE: any of V1–V4). */
export const CRITERION_LEVEL: Readonly<Record<CriterionKind, VerificationLevel | 'V1+'>> = {
  CLAIM_BOUND: 'V0',
  INDEPENDENT_CORROBORATION: 'V1',
  NO_COUNTERPARTY_DENY: 'V1',
  PRIMARY_EVIDENCE: 'V2',
  PRIMARY_EVIDENCE_INTEGRITY: 'V2',
  NO_INVALIDATING_ASSESSMENT: 'V2',
  OFFICIAL_DECLARATION: 'V2',
  NO_AUTHORIZED_DENY: 'V2',
  COMPETITION_SANCTIONED: 'V3',
  CERTIFICATION_ROOTED_IN_SANCTION: 'V3',
  OFFICIAL_EVIDENCE_SET: 'V3',
  IDENTITY_CONFIRMED: 'V3',
  CONDITIONS_COMPLIANT: 'V4',
  INDEPENDENT_PRIMARY_SOURCES: 'V4',
  NON_WITNESSED_SIGNATURES: 'V4',
  RECORD_RATIFIED: 'V4',
  NO_ACTIVE_DISPUTE: 'V1+',
};

/** BRT-01 §6 / BRT-02 §2 — the platform floor: every defined level must contain these. */
export const MANDATORY_CRITERIA: Readonly<Record<VerificationLevel, readonly CriterionKind[]>> = {
  V0: ['CLAIM_BOUND'],
  V1: ['INDEPENDENT_CORROBORATION', 'NO_COUNTERPARTY_DENY'],
  V2: [
    'PRIMARY_EVIDENCE',
    'PRIMARY_EVIDENCE_INTEGRITY',
    'NO_INVALIDATING_ASSESSMENT',
    'OFFICIAL_DECLARATION',
    'NO_AUTHORIZED_DENY',
  ],
  V3: [
    'COMPETITION_SANCTIONED',
    'CERTIFICATION_ROOTED_IN_SANCTION',
    'OFFICIAL_EVIDENCE_SET',
    'IDENTITY_CONFIRMED',
  ],
  V4: [
    'CONDITIONS_COMPLIANT',
    'INDEPENDENT_PRIMARY_SOURCES',
    'NON_WITNESSED_SIGNATURES',
    'RECORD_RATIFIED',
  ],
};

/** Parameters each kind accepts (anything else is rejected). */
const ALLOWED_PARAMS: Readonly<Record<CriterionKind, readonly (keyof CriterionParams)[]>> = {
  CLAIM_BOUND: [],
  INDEPENDENT_CORROBORATION: ['minIssuers'],
  NO_COUNTERPARTY_DENY: [],
  PRIMARY_EVIDENCE: ['minItems', 'availability'],
  PRIMARY_EVIDENCE_INTEGRITY: [],
  NO_INVALIDATING_ASSESSMENT: [],
  OFFICIAL_DECLARATION: ['capabilities'],
  NO_AUTHORIZED_DENY: [],
  COMPETITION_SANCTIONED: ['minRecognitionLevel'],
  CERTIFICATION_ROOTED_IN_SANCTION: [],
  OFFICIAL_EVIDENCE_SET: [],
  IDENTITY_CONFIRMED: [],
  CONDITIONS_COMPLIANT: [],
  INDEPENDENT_PRIMARY_SOURCES: ['minSources'],
  NON_WITNESSED_SIGNATURES: [],
  RECORD_RATIFIED: [],
  NO_ACTIVE_DISPUTE: [],
};

/** BRT-01 V2: the official declaration is exercised through DECLARE_OFFICIAL or ATTEST_RESULT. */
export const OFFICIAL_DECLARATION_CAPABILITIES: readonly Capability[] = [
  'ATTEST_RESULT',
  'DECLARE_OFFICIAL',
];

export const MAX_POLICY_CANONICAL_BYTES = 16 * 1024;

export interface PolicyIssue {
  readonly path: string;
  readonly code: string;
}

export type PolicyValidation =
  | {
      readonly ok: true;
      readonly spec: PolicySpec;
      readonly specHash: ContentHash;
      readonly canonicalText: string;
    }
  | { readonly ok: false; readonly issues: readonly PolicyIssue[] };

/**
 * Validates a policy spec: BR-JSON schema (closed, bounded, no floats/nulls, closed enums for
 * capabilities / recognition levels / criterion kinds), canonical size, then the semantic rules.
 * Returns the normalized spec and its hash:  specHash = H("verification-policy", br:verification-policy@1, JCS).
 */
export function validatePolicySpec(input: unknown): PolicyValidation {
  let normalized: PolicySpec;
  let specHash: ContentHash;
  let canonicalText: string;
  try {
    const r = platformCanonicalizer().hashCanonical(
      DomainTag.verificationPolicy,
      SchemaRef.verificationPolicy.id,
      SchemaRef.verificationPolicy.version,
      input,
    );
    normalized = r.normalized as unknown as PolicySpec;
    specHash = r.contentHash;
    canonicalText = r.canonicalText;
  } catch (err) {
    if (err instanceof CanonicalError)
      return { ok: false, issues: [{ path: err.path || '/', code: err.code }] };
    throw err;
  }
  if (Buffer.byteLength(canonicalText, 'utf8') > MAX_POLICY_CANONICAL_BYTES)
    return { ok: false, issues: [{ path: '/', code: 'POLICY_TOO_LARGE' }] };

  const issues: PolicyIssue[] = [];
  const issue = (path: string, code: string) => issues.push({ path, code });
  if (!SUPPORTED_ENGINE_VERSIONS.includes(normalized.targetEngine))
    issue('/targetEngine', 'ENGINE_VERSION_UNSUPPORTED');

  // Levels form an unbroken chain from V0 (sets are sorted by level: V0 < V1 < …).
  const ids = new Set<string>();
  normalized.levels.forEach((lvl, i) => {
    const path = `/levels/${i}`;
    if (lvl.level !== VERIFICATION_LEVELS[i]) {
      issue(path, i === 0 ? 'LEVEL_V0_MISSING' : 'LEVEL_ANCESTRY_BROKEN');
      return;
    }
    if (lvl.requiresPreviousLevel !== i > 0)
      issue(`${path}/requiresPreviousLevel`, i === 0 ? 'V0_HAS_NO_PREVIOUS' : 'ANCESTRY_REQUIRED');
    const kinds = new Set<CriterionKind>();
    lvl.criteria.forEach((c, j) => {
      const cpath = `${path}/criteria/${j}`;
      if (ids.has(c.id)) issue(`${cpath}/id`, 'DUPLICATE_CRITERION_ID');
      ids.add(c.id);
      if (kinds.has(c.kind)) issue(`${cpath}/kind`, 'DUPLICATE_CRITERION_KIND');
      kinds.add(c.kind);
      const home = CRITERION_LEVEL[c.kind];
      const allowedHere = home === 'V1+' ? lvl.level !== 'V0' : home === lvl.level;
      if (!allowedHere) issue(`${cpath}/kind`, 'CRITERION_NOT_ALLOWED_AT_LEVEL');
      const allowedParams = ALLOWED_PARAMS[c.kind];
      for (const p of Object.keys(c.params ?? {}))
        if (!allowedParams.includes(p as keyof CriterionParams))
          issue(`${cpath}/params/${p}`, 'PARAM_NOT_ALLOWED');
      if (c.kind === 'OFFICIAL_DECLARATION') {
        for (const cap of c.params?.capabilities ?? [])
          if (!OFFICIAL_DECLARATION_CAPABILITIES.includes(cap))
            issue(`${cpath}/params/capabilities`, 'CAPABILITY_NOT_ALLOWED');
      }
    });
    for (const m of MANDATORY_CRITERIA[lvl.level])
      if (!kinds.has(m)) issue(`${path}/criteria`, `MANDATORY_CRITERION_MISSING:${m}`);
  });
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, spec: normalized, specHash, canonicalText };
}

/** Reads a numeric/list parameter with its BRT-01 default. */
export function param<K extends keyof CriterionParams>(
  c: PolicyCriterion,
  key: K,
  fallback: NonNullable<CriterionParams[K]>,
): NonNullable<CriterionParams[K]> {
  return (c.params?.[key] ?? fallback) as NonNullable<CriterionParams[K]>;
}

/**
 * The fictional DEVELOPMENT reference policy (not a universal truth standard). It states BRT-01's
 * floor for every level plus two stricter choices, both documented in BRT-07-VERIFICATION-POLICY.md:
 *   · NO_ACTIVE_DISPUTE from V2 upward (any active dispute claim blocks certification-grade levels);
 *   · team managers, guardians and team-affiliated organizations are also conflicted.
 */
export const REFERENCE_POLICY_CODE = 'br-dev-reference';
export const REFERENCE_POLICY_SPEC: PolicySpec = {
  targetEngine: ENGINE_VERSION,
  levels: [
    {
      level: 'V0',
      requiresPreviousLevel: false,
      criteria: [{ id: 'v0.claim-bound', kind: 'CLAIM_BOUND' }],
    },
    {
      level: 'V1',
      requiresPreviousLevel: true,
      criteria: [
        {
          id: 'v1.independent-corroboration',
          kind: 'INDEPENDENT_CORROBORATION',
          params: { minIssuers: 1 },
        },
        { id: 'v1.no-counterparty-deny', kind: 'NO_COUNTERPARTY_DENY' },
      ],
    },
    {
      level: 'V2',
      requiresPreviousLevel: true,
      criteria: [
        {
          id: 'v2.primary-evidence',
          kind: 'PRIMARY_EVIDENCE',
          params: { minItems: 1, availability: ['AVAILABLE', 'ARCHIVED'] },
        },
        { id: 'v2.primary-evidence-integrity', kind: 'PRIMARY_EVIDENCE_INTEGRITY' },
        { id: 'v2.no-invalidating-assessment', kind: 'NO_INVALIDATING_ASSESSMENT' },
        {
          id: 'v2.official-declaration',
          kind: 'OFFICIAL_DECLARATION',
          params: { capabilities: ['ATTEST_RESULT', 'DECLARE_OFFICIAL'] },
        },
        { id: 'v2.no-authorized-deny', kind: 'NO_AUTHORIZED_DENY' },
        { id: 'v2.no-active-dispute', kind: 'NO_ACTIVE_DISPUTE' },
      ],
    },
    {
      level: 'V3',
      requiresPreviousLevel: true,
      criteria: [
        {
          id: 'v3.competition-sanctioned',
          kind: 'COMPETITION_SANCTIONED',
          params: { minRecognitionLevel: 'REGIONAL' },
        },
        { id: 'v3.certification-rooted-in-sanction', kind: 'CERTIFICATION_ROOTED_IN_SANCTION' },
        { id: 'v3.official-evidence-set', kind: 'OFFICIAL_EVIDENCE_SET' },
        { id: 'v3.identity-confirmed', kind: 'IDENTITY_CONFIRMED' },
        { id: 'v3.no-active-dispute', kind: 'NO_ACTIVE_DISPUTE' },
      ],
    },
    {
      level: 'V4',
      requiresPreviousLevel: true,
      criteria: [
        { id: 'v4.conditions-compliant', kind: 'CONDITIONS_COMPLIANT' },
        {
          id: 'v4.independent-primary-sources',
          kind: 'INDEPENDENT_PRIMARY_SOURCES',
          params: { minSources: 2 },
        },
        { id: 'v4.non-witnessed-signatures', kind: 'NON_WITNESSED_SIGNATURES' },
        { id: 'v4.record-ratified', kind: 'RECORD_RATIFIED' },
        { id: 'v4.no-active-dispute', kind: 'NO_ACTIVE_DISPUTE' },
      ],
    },
  ],
  conflict: {
    additionalProhibitedRelations: [
      'TEAM_MANAGER_OF_PARTICIPANT',
      'GUARDIAN_OF_PARTICIPANT',
      'TEAM_AFFILIATED_ORGANIZATION',
    ],
  },
};
