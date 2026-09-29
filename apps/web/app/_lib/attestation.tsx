/** Public signed-claim DTO (mirrors @br/persistence PublicAttestationV1). */
export interface PublicAttestation {
  schema: string;
  attestationId: string;
  kind: 'CRYPTOGRAPHICALLY_SIGNED_CLAIM';
  notice: string;
  issuer: {
    type: 'ORGANIZATION' | 'INDIVIDUAL' | 'SYSTEM';
    label: string;
    organizationSlug?: string;
  };
  claim: { type: string; polarity: string };
  subject: { type: string; resultVersionId: string; resultId: string };
  issuedOn: string;
  proof: { proofType: string; scheme: string };
  evidence: { count: number; available: number };
  trust: {
    signature: 'VALID_AT_ACCEPTANCE';
    claim: 'ACTIVE' | 'RETRACTED';
    superseded: boolean;
    keyTrust: 'NOT_EVALUATED';
    authority: 'NOT_EVALUATED';
    sportingVerification: 'NOT_IMPLEMENTED';
  };
  retraction?: { reasonCode: string; retractedOn: string };
  supersedesAttestationId?: string;
}

const CLAIMS: Record<string, string> = {
  'RESULT_ACCURATE/AFFIRM':
    'The issuer asserts this exact result version records what they observed',
  'RESULT_ACCURATE/DENY': 'The issuer asserts this exact result version is inaccurate',
  'CONDITIONS_COMPLIANT/AFFIRM':
    'The issuer reports observed conditions for this exact result version',
  'CONDITIONS_COMPLIANT/DENY':
    'The issuer reports non-compliant conditions for this exact result version',
};

export function claimText(a: PublicAttestation): string {
  return CLAIMS[`${a.claim.type}/${a.claim.polarity}`] ?? `${a.claim.type} (${a.claim.polarity})`;
}

/**
 * Separate, explicit trust facets — never one generic "Verified" badge. Each line says exactly
 * what is and is not established.
 */
export function trustFacets(
  a: PublicAttestation,
): { label: string; tone: string; detail: string }[] {
  const grey = '#6b7280';
  return [
    {
      label: 'Signature valid',
      tone: '#0f766e',
      detail:
        'The registered key signed this exact statement (checked when it was accepted). This says nothing about whether the statement is correct.',
    },
    a.trust.claim === 'RETRACTED'
      ? {
          label: 'Claim retracted',
          tone: '#b45309',
          detail: `Withdrawn by the issuer on ${a.retraction?.retractedOn ?? '—'} (${a.retraction?.reasonCode ?? 'OTHER'}). Retracted does not mean false.`,
        }
      : {
          label: 'Claim active',
          tone: '#2563eb',
          detail: 'The issuer has not withdrawn this claim.',
        },
    ...(a.trust.superseded
      ? [
          {
            label: 'Superseded',
            tone: '#b45309',
            detail: 'The issuer later issued a corrected claim.',
          },
        ]
      : []),
    {
      label:
        a.evidence.available === a.evidence.count
          ? 'Evidence available'
          : 'Evidence partly unavailable',
      tone: grey,
      detail: `${a.evidence.available} of ${a.evidence.count} cited evidence item(s) currently available to authorized reviewers. Raw evidence is never public here.`,
    },
    {
      label: 'Key trust not yet evaluated',
      tone: grey,
      detail:
        'Whether the signing key is still trustworthy (e.g. later revoked or compromised) is assessed separately.',
    },
    {
      label: 'Authority not yet evaluated',
      tone: grey,
      detail: 'Whether this issuer holds sporting authority for this result has not been assessed.',
    },
    {
      label: 'Sporting verification not yet implemented',
      tone: grey,
      detail: 'No verification level has been computed for this result.',
    },
  ];
}
