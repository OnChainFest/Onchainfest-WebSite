import type { AuthorityScope, KeyStatusChange } from '@br/domain';
import { newId } from '@br/domain';
import { anchor, at, facts, grant, principal, T0 } from '@br/testkit';
import { describe, expect, it } from 'vitest';
import { staticParticipationChecker } from './conflict';
import { authorize as evaluate, CONFLICT_EXEMPT_CAPABILITIES, isConflictSensitive } from './engine';
import { ALL_CAPABILITIES } from '@br/domain';
import type { AuthorityFacts, AuthorizationRequest, EvaluateOptionsLike, KeyFact } from './facts';

/** Declared participation: nobody participates ⇒ CLEAR (explicit test data source). */
const CLEAR = staticParticipationChecker([], 'test-declared-no-participation');
/** Most tests exercise chain semantics with an explicit CLEAR checker; fail-closed has its own block. */
const authorize = (f: AuthorityFacts, r: AuthorizationRequest, o: EvaluateOptionsLike = {}) =>
  evaluate(f, r, { conflictChecker: CLEAR, ...o });

const competition = newId();
const contest = newId();
const competitionScope: AuthorityScope = {
  sport: ['padel'],
  recognitionLevel: ['PLATFORM'],
  competition: [competition],
};
const contestScope: AuthorityScope = { ...competitionScope, contest: [contest] };

function world() {
  const platform = principal('PLATFORM');
  const org = principal('ORGANIZATION');
  const ref = principal('PERSON');
  const platformAnchor = anchor(platform.id, { recognitionLevel: ['PLATFORM'] });
  const orgGrant = grant({
    grantor: platform.id,
    grantee: org.id,
    capabilities: ['GRANT_AUTHORITY', 'ACCEPT_RESULT', 'DECLARE_OFFICIAL'],
    scope: competitionScope,
    delegable: ['ACCEPT_RESULT'],
    maxDepth: 1,
  });
  const refGrant = grant({
    grantor: org.id,
    grantee: ref.id,
    parent: orgGrant.id,
    capabilities: ['ACCEPT_RESULT'],
    scope: contestScope,
    to: at(600),
  });
  const f = facts({
    principals: [platform, org, ref],
    anchors: [platformAnchor],
    grants: [orgGrant, refGrant],
  });
  return { platform, org, ref, platformAnchor, orgGrant, refGrant, f };
}

const req = (principalId: string, overrides: Record<string, unknown> = {}) =>
  ({
    principalId,
    capability: 'ACCEPT_RESULT',
    scope: contestScope,
    atTime: at(10),
    asOf: at(10),
    ...overrides,
  }) as Parameters<typeof authorize>[1];

describe('authority engine', () => {
  it('authorizes a valid delegated chain and explains it', () => {
    const w = world();
    const d = authorize(w.f, req(w.ref.id));
    expect(d.authorized).toBe(true);
    expect(d.reason).toBe('AUTHORIZED');
    expect(d.anchorId).toBe(w.platformAnchor.id);
    expect(d.grantChain.map((l) => l.grantId)).toEqual([w.refGrant.id, w.orgGrant.id]);
    expect(d.proofDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(d.conflictCheck).toBe('CLEAR');
    expect(d.conflictCheckerId).toBe('test-declared-no-participation');
  });

  it('the proof digest is deterministic over the facts used (evaluatedAt excluded)', () => {
    const w = world();
    const a = authorize(w.f, req(w.ref.id), { evaluatedAt: new Date(1) });
    const b = authorize(w.f, req(w.ref.id), { evaluatedAt: new Date(2) });
    expect(a.proofDigest).toBe(b.proofDigest);
    expect(authorize(w.f, req(w.ref.id, { atTime: at(11) })).proofDigest).not.toBe(a.proofDigest);
  });

  it('denies unknown and unauthorized principals', () => {
    const w = world();
    expect(authorize(w.f, req(newId())).reason).toBe('PRINCIPAL_UNKNOWN');
    const outsider = principal('PERSON');
    expect(
      authorize({ ...w.f, principals: [...w.f.principals, outsider] }, req(outsider.id)).reason,
    ).toBe('NO_GRANT_FOR_CAPABILITY');
    expect(authorize(w.f, req(w.ref.id, { capability: 'DECLARE_OFFICIAL' })).reason).toBe(
      'NO_GRANT_FOR_CAPABILITY',
    );
  });

  it('a referee scoped to contest A cannot act on contest B', () => {
    const w = world();
    const d = authorize(w.f, req(w.ref.id, { scope: { ...competitionScope, contest: [newId()] } }));
    expect(d.authorized).toBe(false);
    expect(d.reason).toBe('SCOPE_NOT_COVERED');
  });

  it('a widened child grant fails at evaluation even if it was stored', () => {
    const w = world();
    const widened = grant({
      grantor: w.org.id,
      grantee: w.ref.id,
      parent: w.orgGrant.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: { sport: ['padel'], recognitionLevel: ['PLATFORM'] },
    });
    const f = { ...w.f, grants: [w.orgGrant, widened] };
    expect(authorize(f, req(w.ref.id)).reason).toBe('SCOPE_WIDENED');
  });

  it('expired grants fail; validity is half-open', () => {
    const w = world();
    expect(authorize(w.f, req(w.ref.id, { atTime: at(599), asOf: at(599) })).authorized).toBe(true);
    expect(authorize(w.f, req(w.ref.id, { atTime: at(600), asOf: at(600) })).reason).toBe(
      'GRANT_NOT_VALID_AT_TIME',
    );
  });

  it('ordinary revocation is prospective; an ancestor revocation cascades by evaluation', () => {
    const w = world();
    const revoke = {
      id: newId(),
      grantId: w.orgGrant.id,
      kind: 'REVOKED' as const,
      compromise: false as const,
      effectiveFrom: at(20),
      recordedAt: at(20),
      reason: 'ended',
    };
    const f = { ...w.f, grantStatusChanges: [revoke] };
    expect(authorize(f, req(w.ref.id, { atTime: at(19), asOf: at(30) })).authorized).toBe(true);
    expect(authorize(f, req(w.ref.id, { atTime: at(20), asOf: at(30) })).reason).toBe(
      'GRANT_REVOKED',
    );
  });

  it('as known now vs as known then: a retroactive compromise revocation', () => {
    const w = world();
    // fraud discovered at minute 300, effective from minute 5
    const revoke = {
      id: newId(),
      grantId: w.refGrant.id,
      kind: 'REVOKED' as const,
      compromise: true as const,
      effectiveFrom: at(5),
      recordedAt: at(300),
      reason: 'fraud',
    };
    const f = { ...w.f, grantStatusChanges: [revoke] };
    expect(authorize(f, req(w.ref.id, { atTime: at(10), asOf: at(10) })).authorized).toBe(true); // as known then
    expect(authorize(f, req(w.ref.id, { atTime: at(10), asOf: at(400) })).reason).toBe(
      'GRANT_REVOKED',
    ); // as known now
  });

  it('a grant recorded after asOf is invisible', () => {
    const w = world();
    const late = grant({
      grantor: w.org.id,
      grantee: w.ref.id,
      parent: w.orgGrant.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: contestScope,
      from: at(50),
      recordedAt: at(50),
    });
    const f = { ...w.f, grants: [w.orgGrant, late] };
    expect(authorize(f, req(w.ref.id, { atTime: at(60), asOf: at(40) })).reason).toBe(
      'NO_GRANT_FOR_CAPABILITY',
    );
    expect(authorize(f, req(w.ref.id, { atTime: at(60), asOf: at(60) })).authorized).toBe(true);
  });

  it('capabilities must be delegable at every hop, and depth is bounded', () => {
    const w = world();
    expect(authorize(w.f, req(w.org.id, { capability: 'DECLARE_OFFICIAL' })).authorized).toBe(true);
    const sneaky = grant({
      grantor: w.org.id,
      grantee: w.ref.id,
      parent: w.orgGrant.id,
      capabilities: ['DECLARE_OFFICIAL'],
      scope: contestScope,
    });
    const f1 = { ...w.f, grants: [w.orgGrant, sneaky] };
    expect(authorize(f1, req(w.ref.id, { capability: 'DECLARE_OFFICIAL' })).reason).toBe(
      'CAPABILITY_NOT_DELEGABLE',
    );

    const assistant = principal('PERSON');
    const refCanDelegate = grant({
      grantor: w.org.id,
      grantee: w.ref.id,
      parent: w.orgGrant.id,
      capabilities: ['GRANT_AUTHORITY', 'ACCEPT_RESULT'],
      scope: contestScope,
      delegable: ['ACCEPT_RESULT'],
    });
    const third = grant({
      grantor: w.ref.id,
      grantee: assistant.id,
      parent: refCanDelegate.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: contestScope,
    });
    const f2 = {
      ...w.f,
      principals: [...w.f.principals, assistant],
      grants: [w.orgGrant, refCanDelegate, third],
    };
    // orgGrant allows maxDepth 1: the assistant is two hops below it
    expect(authorize(f2, req(assistant.id)).reason).toBe('DELEGATION_DEPTH_EXCEEDED');
  });

  it('the PLATFORM principal cannot anchor beyond the PLATFORM level', () => {
    const platform = principal('PLATFORM');
    const org = principal('ORGANIZATION');
    const nationalScope: AuthorityScope = { sport: ['padel'], recognitionLevel: ['NATIONAL'] };
    const forged = anchor(platform.id, { recognitionLevel: ['NATIONAL'] });
    const g = grant({
      grantor: platform.id,
      grantee: org.id,
      capabilities: ['SANCTION'],
      scope: nationalScope,
    });
    const d = authorize(facts({ principals: [platform, org], anchors: [forged], grants: [g] }), {
      principalId: org.id,
      capability: 'SANCTION',
      scope: nationalScope,
      atTime: at(1),
      asOf: at(1),
    });
    expect(d.reason).toBe('ANCHOR_LEVEL_FORBIDDEN');
  });

  it('a federation anchor authorizes only within its recognition scope', () => {
    const fed = principal('ORGANIZATION');
    const org = principal('ORGANIZATION');
    const fedAnchor = anchor(fed.id, {
      sport: ['padel'],
      region: ['CR'],
      recognitionLevel: ['NATIONAL', 'CLUB'],
    });
    const inScope: AuthorityScope = {
      sport: ['padel'],
      region: ['CR-SJ'],
      recognitionLevel: ['CLUB'],
    };
    const g = grant({
      grantor: fed.id,
      grantee: org.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: inScope,
    });
    const f = facts({ principals: [fed, org], anchors: [fedAnchor], grants: [g] });
    expect(
      authorize(f, {
        principalId: org.id,
        capability: 'ACCEPT_RESULT',
        scope: inScope,
        atTime: at(1),
        asOf: at(1),
      }).authorized,
    ).toBe(true);
    const outside = grant({
      grantor: fed.id,
      grantee: org.id,
      capabilities: ['ATTEST_RESULT'],
      scope: { sport: ['padel'], region: ['MX'], recognitionLevel: ['CLUB'] },
    });
    const f2 = { ...f, grants: [outside] };
    expect(
      authorize(f2, {
        principalId: org.id,
        capability: 'ATTEST_RESULT',
        scope: { sport: ['padel'], region: ['MX'], recognitionLevel: ['CLUB'] },
        atTime: at(1),
        asOf: at(1),
      }).reason,
    ).toBe('ANCHOR_SCOPE_NOT_COVERED');
  });

  describe('conflict of interest is fail-closed (BRT-03R)', () => {
    const withSubmit = (w: ReturnType<typeof world>) => {
      const submitGrant = grant({
        grantor: w.platform.id,
        grantee: w.ref.id,
        capabilities: ['SUBMIT_RESULT'],
        scope: contestScope,
      });
      return { ...w.f, grants: [...w.f.grants, submitGrant] };
    };

    it('only SUBMIT_RESULT is exempt; every other capability is conflict-sensitive', () => {
      expect([...CONFLICT_EXEMPT_CAPABILITIES]).toEqual(['SUBMIT_RESULT']);
      for (const c of ALL_CAPABILITIES) expect(isConflictSensitive(c)).toBe(c !== 'SUBMIT_RESULT');
    });

    it('participant conflict → denied, with the chain still explained', () => {
      const w = world();
      const participant = staticParticipationChecker([
        { principalId: w.ref.id, scope: { contest: [contest] } },
      ]);
      const d = authorize(w.f, req(w.ref.id), { conflictChecker: participant });
      expect(d.authorized).toBe(false);
      expect(d.reason).toBe('CONFLICT_OF_INTEREST');
      expect(d.conflictCheck).toBe('CONFLICTED');
      expect(d.grantChain).toHaveLength(2);
    });

    it('checker unavailable (explicit or not supplied) → denied for conflict-sensitive capabilities', () => {
      const w = world();
      const noChecker = evaluate(w.f, req(w.ref.id)); // no checker supplied at all
      expect(noChecker.authorized).toBe(false);
      expect(noChecker.reason).toBe('CONFLICT_CHECK_UNAVAILABLE');
      expect(noChecker.conflictCheck).toBe('UNAVAILABLE');
      expect(noChecker.conflictCheckerId).toBe('participation-index-unavailable');
      const org = evaluate(w.f, req(w.org.id, { capability: 'DECLARE_OFFICIAL' }));
      expect(org.reason).toBe('CONFLICT_CHECK_UNAVAILABLE');
    });

    it('a throwing or malformed checker counts as unavailable', () => {
      const w = world();
      const throwing = {
        id: 'broken',
        check: () => {
          throw new Error('index down');
        },
      };
      expect(authorize(w.f, req(w.ref.id), { conflictChecker: throwing }).reason).toBe(
        'CONFLICT_CHECK_UNAVAILABLE',
      );
      const malformed = { id: 'malformed', check: () => 'MAYBE' as never };
      expect(authorize(w.f, req(w.ref.id), { conflictChecker: malformed }).reason).toBe(
        'CONFLICT_CHECK_UNAVAILABLE',
      );
    });

    it('checker unavailable → SUBMIT_RESULT allowed only when the authority chain permits it', () => {
      const w = world();
      const d = evaluate(withSubmit(w), req(w.ref.id, { capability: 'SUBMIT_RESULT' }));
      expect(d.authorized).toBe(true);
      expect(d.conflictCheck).toBe('NOT_APPLICABLE');
      expect(d.conflictCheckerId).toBe('none');
      const outsider = principal('PERSON');
      const denied = evaluate(
        { ...withSubmit(w), principals: [...w.f.principals, outsider] },
        req(outsider.id, { capability: 'SUBMIT_RESULT' }),
      );
      expect(denied.reason).toBe('NO_GRANT_FOR_CAPABILITY');
    });

    it('non-conflicted authority → allowed; conflict status is part of the proof digest', () => {
      const w = world();
      const clear = authorize(w.f, req(w.ref.id));
      expect(clear.authorized).toBe(true);
      expect(clear.conflictCheck).toBe('CLEAR');
      const other = staticParticipationChecker([], 'another-data-source');
      expect(authorize(w.f, req(w.ref.id), { conflictChecker: other }).proofDigest).not.toBe(
        clear.proofDigest,
      );
      expect(evaluate(w.f, req(w.ref.id)).proofDigest).not.toBe(clear.proofDigest);
    });
  });

  describe('keys and time semantics (BRT-02 §5.1)', () => {
    const w = world();
    const key: KeyFact = {
      id: newId(),
      principalId: w.ref.id,
      keyKind: 'PASSKEY',
      algorithm: 'ES256',
      verificationMaterial: { kty: 'EC' },
      effectiveFrom: T0,
      recordedAt: T0,
      factHash: `sha256:${'b'.repeat(64)}`,
    };
    const compromised: KeyStatusChange = {
      id: newId(),
      keyId: key.id,
      kind: 'COMPROMISED',
      compromisedSince: at(30),
      recordedAt: at(200),
      reason: 'stolen',
    };
    const f = { ...w.f, keys: [key], keyStatusChanges: [compromised] };

    it('acts evaluated before t₀ remain valid; at/after t₀ are rejected as known now', () => {
      expect(
        authorize(f, req(w.ref.id, { keyId: key.id, atTime: at(29), asOf: at(300) })).authorized,
      ).toBe(true);
      expect(
        authorize(f, req(w.ref.id, { keyId: key.id, atTime: at(30), asOf: at(300) })).reason,
      ).toBe('KEY_COMPROMISED');
    });

    it('as known then (before the compromise was recorded) the act was accepted in good faith', () => {
      expect(
        authorize(f, req(w.ref.id, { keyId: key.id, atTime: at(40), asOf: at(40) })).authorized,
      ).toBe(true);
    });

    it('a signer-asserted signedAt cannot backdate an act past a compromise', () => {
      // issuedAt (atTime) after t₀; signedAt claims before t₀ → still rejected
      expect(
        authorize(
          f,
          req(w.ref.id, { keyId: key.id, signedAt: at(1), atTime: at(35), asOf: at(300) }),
        ).reason,
      ).toBe('KEY_COMPROMISED');
      // signedAt after t₀ even if issuedAt were earlier (skew) → rejected
      expect(
        authorize(
          f,
          req(w.ref.id, { keyId: key.id, signedAt: at(31), atTime: at(29), asOf: at(300) }),
        ).reason,
      ).toBe('KEY_COMPROMISED');
    });

    it('ordinary key revocation is prospective and keys must belong to the principal', () => {
      const revoked: KeyStatusChange = {
        id: newId(),
        keyId: key.id,
        kind: 'REVOKED',
        effectiveFrom: at(50),
        recordedAt: at(50),
        reason: 'rotated out',
      };
      const f2 = { ...w.f, keys: [key], keyStatusChanges: [revoked] };
      expect(
        authorize(f2, req(w.ref.id, { keyId: key.id, atTime: at(49), asOf: at(60) })).authorized,
      ).toBe(true);
      expect(
        authorize(f2, req(w.ref.id, { keyId: key.id, atTime: at(50), asOf: at(60) })).reason,
      ).toBe('KEY_REVOKED');
      expect(authorize(f2, req(w.org.id, { keyId: key.id })).reason).toBe('KEY_NOT_OWNED');
    });
  });
});
