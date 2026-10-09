import {
  PRODUCTION_SUPPORTED_FACT_KINDS,
  RecognitionLevel,
  VERIFICATION_LEVEL_IS_NOT_RECOGNITION_LEVEL,
  VERIFICATION_LEVELS,
} from '@br/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateVerification, type VerificationEvaluation } from './engine';
import {
  attestation,
  FIX,
  fixtureId,
  fixtureTime,
  keyOf,
  produce,
  referenceCases,
  referenceWorld,
  withPolicySpec,
  type DraftSnapshot,
} from './fixtures';
import { REFERENCE_POLICY_SPEC, type PolicySpec } from './policy';
import { publicBody, publicStatement } from './public';
import type { VerificationSnapshot } from './snapshot';

/**
 * REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. Every snapshot below is synthetic and
 * in-memory; it exercises the exact BRT-01 criteria whose canonical producers do not exist yet.
 */
const world = referenceWorld();
const evalOf = (s: VerificationSnapshot) => evaluateVerification(s);
const level = (s: VerificationSnapshot) => evalOf(s).outcome.highestSatisfiedLevel;
const criterion = (e: VerificationEvaluation, kind: string) =>
  e.trace.criteria.find((c) => c.kind === kind)!;
const noSanctionsOrRecords = (d: DraftSnapshot) => {
  d.sanctions = [];
  d.ratifications = [];
  delete (d as { recordCategory?: unknown }).recordCategory;
};
const v2World = produce(world, noSanctionsOrRecords);
const shuffle = <T>(xs: readonly T[] | undefined, seed: number): T[] => {
  const a = [...(xs ?? [])];
  let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const j = x % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};

describe('reference cases (V2/V3/V4 pass and blocked)', () => {
  for (const c of referenceCases())
    it(`${c.name}: ${c.description} → ${c.expectedLevel}`, () => {
      const e = evalOf(c.snapshot);
      expect(e.outcome.evaluationState).toBe('EVALUATED');
      expect(e.outcome.highestSatisfiedLevel).toBe(c.expectedLevel);
      // cumulative: every level up to the highest is SATISFIED, the rest are not
      const idx = VERIFICATION_LEVELS.indexOf(c.expectedLevel);
      e.outcome.levels.forEach((l, i) => expect(l.status === 'SATISFIED').toBe(i <= idx));
    });
});

describe('V0 CLAIMED — exact semantics', () => {
  it('a claim whose submitter is unknown establishes no level (outside VerificationLevel)', () => {
    const e = evalOf(
      produce(world, (d) => {
        d.authority.principals = (d.authority.principals ?? []).filter(
          (p) => p.principalId !== FIX.athletePrincipalA,
        );
      }),
    );
    expect(e.outcome.evaluationState).toBe('INSUFFICIENT_INPUT');
    expect(e.outcome.highestSatisfiedLevel).toBeUndefined();
    expect(e.outcome.satisfiedLevels ?? []).toEqual([]);
    expect(e.outcome.levels.map((l) => l.status)).toEqual([
      'BLOCKED',
      'NOT_REACHED',
      'NOT_REACHED',
      'NOT_REACHED',
      'NOT_REACHED',
    ]);
  });

  it('lifecycle status is orthogonal: FINAL, SUBMITTED, REJECTED and SUPERSEDED versions evaluate identically', () => {
    const levels = (['SUBMITTED', 'PROVISIONAL', 'FINAL', 'REJECTED', 'SUPERSEDED'] as const).map(
      (status) =>
        level(
          produce(v2World, (d) => {
            d.resultVersion.status = status;
          }),
        ),
    );
    expect(new Set(levels)).toEqual(new Set(['V2']));
  });

  it('a snapshot pins one exact version: another version id / hash is another input', () => {
    const a = evalOf(v2World);
    const b = evalOf(
      produce(v2World, (d) => {
        d.resultVersion.contentHash = `sha256:${'1'.repeat(64)}`;
      }),
    );
    expect(b.snapshotHash).not.toBe(a.snapshotHash);
  });
});

describe('V1 CORROBORATED — independence (principal- and participation-based)', () => {
  const v1Only = produce(v2World, (d) => {
    d.attestations = [
      attestation('b-confirms', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 60),
    ];
  });

  it('opponent corroboration → V1; no corroboration → V0', () => {
    expect(level(v1Only)).toBe('V1');
    expect(
      level(
        produce(v1Only, (d) => {
          d.attestations = [];
        }),
      ),
    ).toBe('V0');
  });

  it('two keys and three attestations of ONE principal are one issuer group', () => {
    const twoIssuers: PolicySpec = {
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
    const e = evalOf(
      withPolicySpec(
        produce(v1Only, (d) => {
          d.attestations = [
            attestation('b1', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 60),
            attestation('b2', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 61, {
              keyId: keyOf(FIX.athletePrincipalB, 2),
            }),
            attestation('b3', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 62),
          ];
        }),
        twoIssuers,
      ),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    const c = criterion(e, 'INDEPENDENT_CORROBORATION');
    expect(c).toMatchObject({ status: 'FAIL', observed: 1, required: 2 });
    expect(c.issuerGroups).toHaveLength(1);
    expect(c.issuerGroups![0]!.attestationIds).toHaveLength(3);
  });

  it("a principal on the submitter's side never corroborates (teammate / lineup / guardian)", () => {
    for (const kind of [
      'TEAM_MEMBER_OF_PARTICIPANT',
      'LINEUP_MEMBER_OF_PARTICIPANT',
      'GUARDIAN_OF_PARTICIPANT',
    ] as const) {
      const mate = fixtureId(`mate-${kind}`);
      const e = evalOf(
        produce(v1Only, (d) => {
          d.authority.principals!.push({
            principalId: mate,
            principalType: 'PERSON',
            recordedAt: fixtureTime(0),
          });
          d.keys!.push({
            keyId: keyOf(mate),
            principalId: mate,
            keyKind: 'JWK',
            algorithm: 'EdDSA',
            factHash: `sha256:${'b'.repeat(64)}`,
            effectiveFrom: fixtureTime(0),
            recordedAt: fixtureTime(0),
          });
          d.participation.principals!.push({
            principalId: mate,
            principalType: 'PERSON',
            resolution: 'RESOLVED',
            relations: [{ kind, participantId: FIX.participantA, timing: 'STRUCTURAL' }],
          });
          d.attestations = [attestation(`mate-${kind}`, mate, 'PERSON', 'RESULT_ACCURATE', 60)];
        }),
      );
      expect(e.outcome.highestSatisfiedLevel).toBe('V0');
      expect(criterion(e, 'INDEPENDENT_CORROBORATION').issuerGroups![0]!.classification).toBe(
        'SAME_SIDE_AS_SUBMITTER',
      );
    }
  });

  it('unknown participation never counts as independent (UNKNOWN, never PASS)', () => {
    const e = evalOf(
      produce(v1Only, (d) => {
        d.participation.principals = d.participation.principals!.map((p) =>
          p.principalId === FIX.athletePrincipalB
            ? { ...p, resolution: 'UNRESOLVED', relations: [] }
            : p,
        );
      }),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    expect(criterion(e, 'INDEPENDENT_CORROBORATION').status).toBe('UNKNOWN');
  });

  it('an unresolved contest slot makes "not on any side" unprovable for non-participants', () => {
    const e = evalOf(
      produce(v1Only, (d) => {
        d.participation.sidesComplete = false;
        d.attestations = [
          attestation('platform-official', FIX.platformOfficial, 'PERSON', 'RESULT_ACCURATE', 60),
        ];
      }),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    expect(e.outcome.flags).toContain('PARTICIPATION_INCOMPLETE');
  });

  it('a retracted, superseded or key-compromised corroboration stops counting', () => {
    for (const mutate of [
      (d: DraftSnapshot) => {
        d.attestations![0]!.status = 'RETRACTED';
      },
      (d: DraftSnapshot) => {
        d.attestations![0]!.status = 'SUPERSEDED';
      },
      (d: DraftSnapshot) => {
        d.keys = d.keys!.map((k) =>
          k.keyId === keyOf(FIX.athletePrincipalB)
            ? {
                ...k,
                statusChanges: [
                  {
                    statusChangeId: fixtureId('c'),
                    kind: 'COMPROMISED',
                    effectiveFrom: fixtureTime(50),
                    compromisedSince: fixtureTime(50),
                    recordedAt: fixtureTime(500),
                  },
                ],
              }
            : k,
        );
      },
    ])
      expect(level(produce(v1Only, mutate))).toBe('V0');
  });

  it('a later signedAt can never resurrect a key compromised before issuance; an earlier compromise date is retroactive', () => {
    const e = evalOf(
      produce(v1Only, (d) => {
        d.attestations![0]!.signedAt = fixtureTime(10);
        d.keys = d.keys!.map((k) =>
          k.keyId === keyOf(FIX.athletePrincipalB)
            ? {
                ...k,
                statusChanges: [
                  {
                    statusChangeId: fixtureId('c2'),
                    kind: 'COMPROMISED',
                    effectiveFrom: fixtureTime(55),
                    compromisedSince: fixtureTime(55),
                    recordedAt: fixtureTime(900),
                  },
                ],
              }
            : k,
        );
      }),
    );
    expect(
      e.trace.signedFacts!.find((f) => f.attestationId === fixtureId('fact:b-confirms')),
    ).toMatchObject({
      keyTrust: 'SUSPECT',
      counts: false,
    });
  });

  it('a counterparty DENY blocks V1 (and flags the contradiction)', () => {
    const e = evalOf(
      produce(v1Only, (d) => {
        d.attestations!.push(
          attestation('b-denies', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 90, {
            polarity: 'DENY',
          }),
        );
      }),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    expect(e.outcome.flags).toContain('CONTRADICTING_ATTESTATION');
    expect(publicBody(e.outcome).activeDispute).toBe(true);
  });
});

describe('V2 EVENT_CERTIFIED — both accepted paths, nothing simplified', () => {
  it('RESULT_OFFICIAL path and RESULT_ACCURATE + T5 path both certify', () => {
    const cases = referenceCases();
    expect(level(cases.find((c) => c.name === 'v2-result-official')!.snapshot)).toBe('V2');
    expect(level(cases.find((c) => c.name === 'v2-accurate-plus-t5')!.snapshot)).toBe('V2');
  });

  it('missing producers → V1 ceiling with INPUT_NOT_SUPPORTED (never FAIL, never inferred)', () => {
    const e = evalOf(referenceCases().find((c) => c.name === 'v1-production-kinds')!.snapshot);
    expect(e.outcome.highestSatisfiedLevel).toBe('V1');
    expect(criterion(e, 'OFFICIAL_DECLARATION').status).toBe('INPUT_NOT_SUPPORTED');
  });

  const withDeclarer = (issuer: string, type: 'PERSON' | 'ORGANIZATION') =>
    produce(v2World, (d) => {
      d.attestations = d.attestations!.map((a) =>
        a.claimType === 'RESULT_OFFICIAL'
          ? {
              ...a,
              attestationId: fixtureId(`decl-${issuer}`),
              issuerPrincipalId: issuer,
              issuerPrincipalType: type,
              keyId: keyOf(issuer),
            }
          : a,
      );
    });

  it('wrong authority, competition staff, organizer and FEDERATION-anchor organization cannot certify', () => {
    expect(level(withDeclarer(FIX.sanctioner, 'PERSON'))).toBe('V1'); // SANCTION only
    expect(level(withDeclarer(FIX.staffAdmin, 'PERSON'))).toBe('V1'); // operational staff, no grant
    expect(level(withDeclarer(FIX.organizer, 'ORGANIZATION'))).toBe('V1'); // organizer organization
    expect(level(withDeclarer(FIX.federation, 'ORGANIZATION'))).toBe('V1'); // anchor principal holds no grant
  });

  const grantOf = (d: DraftSnapshot, label: string) =>
    d.authority.grants!.find((g) => g.grantId === fixtureId(`grant:${label}`))!;

  it('expired, revoked (ordinary before T / compromise), sibling-scoped and later-recorded grants cannot certify', () => {
    expect(
      level(
        produce(v2World, (d) => {
          grantOf(d, 'official').effectiveTo = fixtureTime(69);
        }),
      ),
    ).toBe('V1');
    expect(
      level(
        produce(v2World, (d) => {
          d.authority.grantStatusChanges = [
            {
              statusChangeId: fixtureId('rv'),
              grantId: fixtureId('grant:official'),
              compromise: false,
              effectiveFrom: fixtureTime(65),
              recordedAt: fixtureTime(65),
            },
          ];
        }),
      ),
    ).toBe('V1');
    // ordinary revocation AFTER the declaration is prospective: still certified
    expect(
      level(
        produce(v2World, (d) => {
          d.authority.grantStatusChanges = [
            {
              statusChangeId: fixtureId('rv2'),
              grantId: fixtureId('grant:official'),
              compromise: false,
              effectiveFrom: fixtureTime(200),
              recordedAt: fixtureTime(200),
            },
          ];
        }),
      ),
    ).toBe('V2');
    // compromise revocation is retroactive
    expect(
      level(
        produce(v2World, (d) => {
          d.authority.grantStatusChanges = [
            {
              statusChangeId: fixtureId('rv3'),
              grantId: fixtureId('grant:official'),
              compromise: true,
              effectiveFrom: fixtureTime(1),
              recordedAt: fixtureTime(300),
            },
          ];
        }),
      ),
    ).toBe('V1');
    expect(
      level(
        produce(v2World, (d) => {
          grantOf(d, 'official').scope = {
            ...grantOf(d, 'official').scope,
            competition: [FIX.siblingCompetition as never],
          };
        }),
      ),
    ).toBe('V1');
    const later = evalOf(
      produce(v2World, (d) => {
        const g = grantOf(d, 'official');
        g.effectiveFrom = fixtureTime(100);
        g.recordedAt = fixtureTime(100);
      }),
    );
    expect(later.outcome.highestSatisfiedLevel).toBe('V1');
    expect(
      criterion(later, 'OFFICIAL_DECLARATION').authority!.some(
        (a) => a.reason === 'GRANT_NOT_VALID_AT_TIME',
      ),
    ).toBe(true);
  });

  it('a prohibited participant conflict voids the certifying authority', () => {
    const e = evalOf(
      produce(v2World, (d) => {
        d.participation.principals = d.participation.principals!.map((p) =>
          p.principalId === FIX.official
            ? {
                ...p,
                relations: [
                  {
                    kind: 'LINEUP_MEMBER_OF_PARTICIPANT',
                    participantId: FIX.participantB,
                    timing: 'STRUCTURAL',
                  },
                ],
              }
            : p,
        );
      }),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V1');
    expect(
      criterion(e, 'OFFICIAL_DECLARATION').authority!.some(
        (a) => a.reason === 'CONFLICT_OF_INTEREST',
      ),
    ).toBe(true);
  });

  it('policy-added relations are conflicts too; unknown participation of the certifier fails closed', () => {
    expect(
      level(
        produce(v2World, (d) => {
          d.participation.principals = d.participation.principals!.map((p) =>
            p.principalId === FIX.official
              ? {
                  ...p,
                  relations: [
                    {
                      kind: 'GUARDIAN_OF_PARTICIPANT',
                      participantId: FIX.participantB,
                      timing: 'DURING_OCCURRENCE',
                    },
                  ],
                }
              : p,
          );
        }),
      ),
    ).toBe('V1');
    const e = evalOf(
      produce(v2World, (d) => {
        d.participation.principals = d.participation.principals!.map((p) =>
          p.principalId === FIX.official ? { ...p, resolution: 'UNRESOLVED' } : p,
        );
      }),
    );
    expect(criterion(e, 'OFFICIAL_DECLARATION').status).toBe('UNKNOWN');
  });

  it('generic AI-derived evidence can never be the only primary evidence (E-4, non-bypassable)', () => {
    const e = evalOf(
      produce(v2World, (d) => {
        d.discipline.primaryEvidenceTypes = ['AI_DERIVED'];
        d.evidence = [
          {
            ...d.evidence![0]!,
            evidenceType: 'AI_DERIVED',
            sourceKind: 'AI_PIPELINE',
            generatorKind: 'AI_PIPELINE',
          },
        ];
      }),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V1');
    expect(criterion(e, 'PRIMARY_EVIDENCE')).toMatchObject({
      status: 'FAIL',
      reasons: ['AI_ONLY_EVIDENCE'],
    });
    expect(e.outcome.flags).toContain('AI_ONLY_EVIDENCE');
    // AI supporting a human scoresheet is fine
    expect(
      level(
        produce(v2World, (d) => {
          d.discipline.primaryEvidenceTypes = ['SIGNED_SCORESHEET', 'AI_DERIVED'];
          d.evidence!.push({
            ...d.evidence![0]!,
            evidenceId: fixtureId('ai'),
            evidenceType: 'AI_DERIVED',
            sourceKind: 'AI_PIPELINE',
            provenanceRootId: fixtureId('ai'),
          });
        }),
      ),
    ).toBe('V2');
  });

  it('unavailable, non-primary-typed or invalidated primary evidence does not count', () => {
    const only = (e: Partial<NonNullable<VerificationSnapshot['evidence']>[number]>) =>
      produce(v2World, (d) => {
        d.evidence = d.evidence!.map((x) => ({ ...x, ...e }) as typeof x);
      });
    expect(level(only({ availability: 'RESTRICTED' }))).toBe('V1');
    expect(level(only({ availability: 'DELETED_BY_ERASURE' }))).toBe('V1');
    expect(level(only({ evidenceType: 'IMAGE' }))).toBe('V1');
    expect(level(only({ versionRoles: ['SUPPORTING'] }))).toBe('V1');
    expect(
      level(
        produce(v2World, (d) => {
          d.evidenceAssessments = d.evidence!.map((x, i) => ({
            assessmentId: fixtureId(`as${i}`),
            evidenceId: x.evidenceId,
            finding: 'MANIPULATED',
          }));
        }),
      ),
    ).toBe('V1');
  });

  it('an authorized DENY blocks V2; a counterparty DENY is outranked by the certification (BRT-01 §5.3)', () => {
    expect(
      level(
        produce(v2World, (d) => {
          d.attestations!.push(
            attestation('off-deny', FIX.platformOfficial, 'PERSON', 'RESULT_ACCURATE', 95, {
              polarity: 'DENY',
            }),
          );
        }),
      ),
    ).toBe('V1');
    const bDenies = produce(v2World, (d) => {
      d.attestations!.push(
        attestation('b-denies', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 95, {
          polarity: 'DENY',
        }),
      );
    });
    // BRT-01 floor (no NO_ACTIVE_DISPUTE): the certification outranks the participant → V2.
    const floor: PolicySpec = {
      ...REFERENCE_POLICY_SPEC,
      levels: REFERENCE_POLICY_SPEC.levels.map((l) => ({
        ...l,
        criteria: l.criteria.filter((c) => c.kind !== 'NO_ACTIVE_DISPUTE'),
      })),
    };
    const e = evalOf(withPolicySpec(bDenies, floor));
    expect(e.outcome.highestSatisfiedLevel).toBe('V2');
    expect(criterion(e, 'NO_COUNTERPARTY_DENY').reasons).toContain(
      'COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION',
    );
    // The (stricter) reference policy adds NO_ACTIVE_DISPUTE from V2: V1 holds, V2 is blocked.
    expect(level(bDenies)).toBe('V1');
  });
});

describe('BRT-07R V1 — counterparty or REGISTERED official; authority requirement none', () => {
  const REFEREE = fixtureId('registered-referee');
  const noGrants = (d: DraftSnapshot) => {
    d.authority.grants = [];
  };
  const withoutB = (d: DraftSnapshot) => {
    d.attestations = d.attestations!.filter((a) => a.issuerPrincipalId !== FIX.athletePrincipalB);
  };
  /** A fresh PERSON principal on no side, with a key, NO grant, and optionally a registration. */
  const referee = (d: DraftSnapshot, registration?: { from: number; to?: number }) => {
    d.authority.principals!.push({
      principalId: REFEREE,
      principalType: 'PERSON',
      recordedAt: fixtureTime(0),
    });
    d.keys!.push({
      keyId: keyOf(REFEREE),
      principalId: REFEREE,
      keyKind: 'JWK',
      algorithm: 'EdDSA',
      factHash: `sha256:${'c'.repeat(64)}`,
      effectiveFrom: fixtureTime(0),
      recordedAt: fixtureTime(0),
    });
    d.participation.principals!.push({
      principalId: REFEREE,
      principalType: 'PERSON',
      resolution: 'RESOLVED',
    });
    if (registration !== undefined)
      d.registeredOfficials = [
        {
          registrationId: fixtureId('registration:referee'),
          principalId: REFEREE,
          subjectLevel: 'CONTEST',
          subjectId: FIX.contest,
          effectiveFrom: fixtureTime(registration.from),
          ...(registration.to === undefined ? {} : { effectiveTo: fixtureTime(registration.to) }),
          recordedAt: fixtureTime(registration.from),
        },
      ];
    d.attestations!.push(attestation('referee-confirms', REFEREE, 'PERSON', 'RESULT_ACCURATE', 60));
  };
  const production = (d: DraftSnapshot) => {
    d.supportedFactKinds = [...PRODUCTION_SUPPORTED_FACT_KINDS];
  };
  const groupOf = (e: VerificationEvaluation, principalId: string) =>
    criterion(e, 'INDEPENDENT_CORROBORATION').issuerGroups!.find(
      (g) => g.principalId === principalId,
    )!;

  it('A · a counterparty AFFIRM satisfies V1 without any AuthorityGrant', () => {
    const e = evalOf(produce(world, (d) => (production(d), noGrants(d))));
    expect(e.outcome.highestSatisfiedLevel).toBe('V1');
    const c = criterion(e, 'INDEPENDENT_CORROBORATION');
    expect(c.status).toBe('PASS');
    expect(c.authority ?? []).toEqual([]);
    expect(groupOf(e, FIX.athletePrincipalB).classification).toBe('COUNTERPARTY');
  });

  it("B · a principal on the submitter's side cannot satisfy V1", () => {
    const e = evalOf(
      produce(world, (d) => {
        production(d);
        withoutB(d);
        referee(d);
        d.participation.principals!.find((p) => p.principalId === REFEREE)!.relations = [
          {
            kind: 'LINEUP_MEMBER_OF_PARTICIPANT',
            participantId: FIX.participantA,
            timing: 'STRUCTURAL',
          },
        ];
      }),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    expect(groupOf(e, REFEREE).classification).toBe('SAME_SIDE_AS_SUBMITTER');
  });

  it('C · several keys and attestations of one principal count once', () => {
    const spec: PolicySpec = {
      ...REFERENCE_POLICY_SPEC,
      levels: REFERENCE_POLICY_SPEC.levels.map((l) => ({
        ...l,
        criteria: l.criteria.map((c) =>
          c.kind === 'INDEPENDENT_CORROBORATION' ? { ...c, params: { minIssuers: 2 } } : c,
        ),
      })),
    };
    const e = evalOf(
      withPolicySpec(
        produce(world, (d) => {
          production(d);
          d.attestations!.push(
            attestation('b-again', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 61, {
              keyId: keyOf(FIX.athletePrincipalB, 2),
            }),
          );
        }),
        spec,
      ),
    );
    const c = criterion(e, 'INDEPENDENT_CORROBORATION');
    expect(c.observed).toBe(1);
    expect(c.status).toBe('FAIL');
    expect(groupOf(e, FIX.athletePrincipalB).attestationIds).toHaveLength(2);
  });

  it('D · a REGISTERED_OFFICIAL fact satisfies V1 with no ATTEST_RESULT (synthetic fixture)', () => {
    const e = evalOf(produce(world, (d) => (withoutB(d), noGrants(d), referee(d, { from: 0 }))));
    expect(e.outcome.highestSatisfiedLevel).toBe('V1');
    const c = criterion(e, 'INDEPENDENT_CORROBORATION');
    expect(c.status).toBe('PASS');
    expect(c.reasons).toContain('REGISTERED_OFFICIAL_PATH_EVALUATED');
    expect(c.authority ?? []).toEqual([]);
    expect(groupOf(e, REFEREE).classification).toBe('REGISTERED_OFFICIAL');
    // registration outside the attestation time, or for another subject, is no registration
    const expired = evalOf(produce(world, (d) => (withoutB(d), referee(d, { from: 0, to: 50 }))));
    expect(groupOf(expired, REFEREE).reasons).toContain('NOT_REGISTERED_OFFICIAL');
    expect(expired.outcome.highestSatisfiedLevel).toBe('V0');
    // a registered official with a prohibited relation is not independent
    const conflicted = evalOf(
      produce(world, (d) => {
        withoutB(d);
        referee(d, { from: 0 });
        d.participation.principals!.find((p) => p.principalId === REFEREE)!.relations = [
          {
            kind: 'TEAM_MANAGER_OF_PARTICIPANT',
            participantId: FIX.participantB,
            timing: 'DURING_OCCURRENCE',
          },
        ];
      }),
    );
    expect(groupOf(conflicted, REFEREE).classification).toBe('COUNTERPARTY'); // on B's side
    const staffConflict = evalOf(
      withPolicySpec(
        produce(world, (d) => {
          withoutB(d);
          referee(d, { from: 0 });
          d.participation.principals!.find((p) => p.principalId === REFEREE)!.relations = [
            { kind: 'COMPETITION_STAFF', timing: 'DURING_OCCURRENCE' },
          ];
        }),
        {
          ...REFERENCE_POLICY_SPEC,
          conflict: { additionalProhibitedRelations: ['COMPETITION_STAFF'] },
        },
      ),
    );
    expect(groupOf(staffConflict, REFEREE).reasons).toContain('REGISTERED_OFFICIAL_CONFLICTED');
    expect(staffConflict.outcome.highestSatisfiedLevel).toBe('V0');
  });

  it('E · an ATTEST_RESULT grant alone never makes a registered official', () => {
    const e = evalOf(
      produce(v2World, (d) => {
        withoutB(d);
        d.attestations!.push(
          attestation('official-accurate', FIX.official, 'PERSON', 'RESULT_ACCURATE', 65),
        );
      }),
    );
    const g = groupOf(e, FIX.official);
    expect(g.classification).toBe('NO_STANDING');
    expect(g.reasons).toContain('NOT_REGISTERED_OFFICIAL');
    expect(criterion(e, 'INDEPENDENT_CORROBORATION').status).toBe('FAIL');
    expect(e.outcome.highestSatisfiedLevel).toBe('V0'); // cumulative: no V1 ⇒ no V2
  });

  it('F · production snapshots report the registered-official path as unavailable', () => {
    const e = evalOf(produce(world, (d) => (production(d), withoutB(d), referee(d, { from: 0 }))));
    const c = criterion(e, 'INDEPENDENT_CORROBORATION');
    expect(c.reasons).toContain('NOT_SUPPORTED_REGISTERED_OFFICIAL');
    expect(groupOf(e, REFEREE).reasons).toContain('NOT_SUPPORTED_REGISTERED_OFFICIAL');
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    // …while counterparty corroboration keeps V1 reachable in production
    const cp = evalOf(produce(world, production));
    expect(cp.outcome.highestSatisfiedLevel).toBe('V1');
    expect(criterion(cp, 'INDEPENDENT_CORROBORATION').reasons).toContain(
      'NOT_SUPPORTED_REGISTERED_OFFICIAL',
    );
    expect(PRODUCTION_SUPPORTED_FACT_KINDS).not.toContain('REGISTERED_OFFICIAL');
  });
});

describe('ADR-0036 — counterparty DENY vs the V2 certification exception (V2 ⇒ V1 ⇒ V0)', () => {
  const B2 = fixtureId('athlete-principal-b2');
  const floor: PolicySpec = {
    ...REFERENCE_POLICY_SPEC,
    levels: REFERENCE_POLICY_SPEC.levels.map((l) => ({
      ...l,
      criteria: l.criteria.filter((c) => c.kind !== 'NO_ACTIVE_DISPUTE'),
    })),
  };
  /** B2 (lineup member of B) AFFIRMs; B DENYs → a counterparty DENY alongside a corroboration. */
  const disputed = (d: DraftSnapshot) => {
    d.authority.principals!.push({
      principalId: B2,
      principalType: 'PERSON',
      recordedAt: fixtureTime(0),
    });
    d.keys!.push({
      keyId: keyOf(B2),
      principalId: B2,
      keyKind: 'JWK',
      algorithm: 'EdDSA',
      factHash: `sha256:${'d'.repeat(64)}`,
      effectiveFrom: fixtureTime(0),
      recordedAt: fixtureTime(0),
    });
    d.participation.principals!.push({
      principalId: B2,
      principalType: 'PERSON',
      resolution: 'RESOLVED',
      relations: [
        {
          kind: 'LINEUP_MEMBER_OF_PARTICIPANT',
          participantId: FIX.participantB,
          timing: 'STRUCTURAL',
        },
      ],
    });
    d.attestations = d.attestations!.filter((a) => a.issuerPrincipalId !== FIX.athletePrincipalB);
    d.attestations.push(attestation('b2-confirms', B2, 'PERSON', 'RESULT_ACCURATE', 60));
    d.attestations.push(
      attestation('b-denies', FIX.athletePrincipalB, 'PERSON', 'RESULT_ACCURATE', 62, {
        polarity: 'DENY',
      }),
    );
  };
  const statusOf = (e: VerificationEvaluation, lvl: string) =>
    e.outcome.levels.find((l) => l.level === lvl)!.status;

  it('1 · AFFIRM and no DENY → V1', () => {
    const e = evalOf(
      withPolicySpec(
        produce(v2World, (d) => (d.supportedFactKinds = [...PRODUCTION_SUPPORTED_FACT_KINDS])),
        floor,
      ),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V1');
    expect(criterion(e, 'NO_COUNTERPARTY_DENY').reasons).toEqual(['NO_COUNTERPARTY_DENY']);
  });

  it('2 · AFFIRM + counterparty DENY without V2 → V0 at most', () => {
    const e = evalOf(
      withPolicySpec(
        produce(v2World, (d) => {
          disputed(d);
          d.supportedFactKinds = [...PRODUCTION_SUPPORTED_FACT_KINDS];
        }),
        floor,
      ),
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
    const c = criterion(e, 'NO_COUNTERPARTY_DENY');
    expect(c.status).toBe('FAIL');
    expect(c.reasons).toEqual(['COUNTERPARTY_DENY', 'V2_CERTIFICATION_EXCEPTION_NOT_MET']);
    expect(criterion(e, 'INDEPENDENT_CORROBORATION').status).toBe('PASS');
  });

  it('3 · #2 + a valid V2 declaration and no authorized DENY → V2, with V1 satisfied', () => {
    const e = evalOf(withPolicySpec(produce(v2World, disputed), floor));
    expect(e.outcome.highestSatisfiedLevel).toBe('V2');
    expect(statusOf(e, 'V1')).toBe('SATISFIED');
    const c = criterion(e, 'NO_COUNTERPARTY_DENY');
    expect(c.status).toBe('PASS');
    expect([...c.reasons].sort()).toEqual([
      'COUNTERPARTY_DENY_OUTRANKED_BY_CERTIFICATION',
      'COUNTERPARTY_DENY_PRESENT',
      'V2_NO_AUTHORIZED_DENY_PASSED',
      'V2_OFFICIAL_DECLARATION_PASSED',
    ]);
    expect(publicBody(e.outcome).activeDispute).toBe(true); // the dispute stays visible
  });

  it('4 · a valid declaration + an authorized official DENY → V2 blocked (and no exception)', () => {
    const e = evalOf(
      withPolicySpec(
        produce(v2World, (d) => {
          disputed(d);
          d.attestations!.push(
            attestation('off-deny', FIX.platformOfficial, 'PERSON', 'RESULT_ACCURATE', 95, {
              polarity: 'DENY',
            }),
          );
        }),
        floor,
      ),
    );
    expect(criterion(e, 'OFFICIAL_DECLARATION').status).toBe('PASS');
    expect(criterion(e, 'NO_AUTHORIZED_DENY').status).toBe('FAIL');
    expect(statusOf(e, 'V2')).not.toBe('SATISFIED');
    expect(criterion(e, 'NO_COUNTERPARTY_DENY').reasons).toContain(
      'V2_CERTIFICATION_EXCEPTION_NOT_MET',
    );
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
  });
});

describe('BRT-07R temporal participation in the engine', () => {
  const setRelations = (
    d: DraftSnapshot,
    principalId: string,
    p: Partial<
      DraftSnapshot['participation']['principals'] extends (infer U)[] | undefined ? U : never
    >,
  ) => {
    d.participation.principals = d.participation.principals!.map((x) =>
      x.principalId === principalId ? { ...x, ...p } : x,
    );
  };

  it('a corroborator whose side relation is UNDETERMINED is UNKNOWN (never counterparty, never independent)', () => {
    const e = evalOf(
      produce(world, (d) => {
        d.supportedFactKinds = [...PRODUCTION_SUPPORTED_FACT_KINDS];
        setRelations(d, FIX.athletePrincipalB, {
          resolution: 'TEMPORALLY_UNDETERMINED',
          relations: [
            {
              kind: 'TEAM_MEMBER_OF_PARTICIPANT',
              participantId: FIX.participantB,
              timing: 'UNDETERMINED',
            },
          ],
        });
      }),
    );
    const c = criterion(e, 'INDEPENDENT_CORROBORATION');
    expect(c.status).toBe('UNKNOWN');
    expect(c.issuerGroups![0]!.reasons).toContain('RELATION_TIME_UNDETERMINED');
    expect(e.outcome.highestSatisfiedLevel).toBe('V0');
  });

  it('a certain direct participation conflicts regardless of another undetermined relation', () => {
    const e = evalOf(
      produce(v2World, (d) =>
        setRelations(d, FIX.official, {
          resolution: 'TEMPORALLY_UNDETERMINED',
          relations: [
            { kind: 'SELF_PARTICIPANT', participantId: FIX.participantB, timing: 'STRUCTURAL' },
            { kind: 'COMPETITION_STAFF', timing: 'UNDETERMINED' },
          ],
        }),
      ),
    );
    expect(
      criterion(e, 'OFFICIAL_DECLARATION').authority!.some(
        (a) => a.reason === 'CONFLICT_OF_INTEREST',
      ),
    ).toBe(true);
  });

  it('an undetermined prohibited relation makes the conflict check UNAVAILABLE (never CLEAR)', () => {
    const e = evalOf(
      produce(v2World, (d) =>
        setRelations(d, FIX.official, {
          resolution: 'TEMPORALLY_UNDETERMINED',
          relations: [
            {
              kind: 'TEAM_MEMBER_OF_PARTICIPANT',
              participantId: FIX.participantB,
              timing: 'UNDETERMINED',
            },
          ],
        }),
      ),
    );
    const c = criterion(e, 'OFFICIAL_DECLARATION');
    expect(c.status).toBe('UNKNOWN');
    expect(c.authority!.some((a) => a.reason === 'CONFLICT_CHECK_UNAVAILABLE')).toBe(true);
  });
});

describe('V3 SANCTIONED', () => {
  const v3 = produce(world, (d) => {
    d.ratifications = [];
  });
  it('V2 alone is not V3; the full sanction set is V3', () => {
    expect(level(v2World)).toBe('V2');
    expect(level(v3)).toBe('V3');
  });
  it('missing identity / official evidence set / sanction producers block V3', () => {
    expect(
      level(
        produce(v3, (d) => {
          d.identityConfirmations = [d.identityConfirmations![0]!];
        }),
      ),
    ).toBe('V2');
    expect(
      level(
        produce(v3, (d) => {
          d.evidence = d.evidence!.filter((e) => e.evidenceType !== 'TIMING_SYSTEM_EXPORT');
        }),
      ),
    ).toBe('V2');
    expect(
      level(
        produce(v3, (d) => {
          delete (d as { officialEvidenceSet?: unknown }).officialEvidenceSet;
        }),
      ),
    ).toBe('V2');
    const e = evalOf(
      produce(v3, (d) => {
        d.supportedFactKinds = d.supportedFactKinds.filter(
          (k) => k !== 'COMPETITION_SANCTIONED_ATTESTATION',
        );
      }),
    );
    expect(criterion(e, 'COMPETITION_SANCTIONED').status).toBe('INPUT_NOT_SUPPORTED');
  });
  it('recognition too low, wrong hierarchy, platform ceiling, and non-rooted certification block V3', () => {
    const low = evalOf(
      produce(v3, (d) => {
        d.sanctions![0]!.recognitionLevel = 'CLUB';
      }),
    );
    expect(low.outcome.highestSatisfiedLevel).toBe('V2');
    expect(criterion(low, 'COMPETITION_SANCTIONED').reasons).toContain('RECOGNITION_TOO_LOW');
    expect(
      level(
        produce(v3, (d) => {
          d.sanctions![0]!.subjectId = fixtureId('sibling-event');
        }),
      ),
    ).toBe('V2');
    const platform = evalOf(
      produce(v3, (d) => {
        d.sanctions![0]!.recognitionLevel = 'PLATFORM';
      }),
    );
    expect(criterion(platform, 'COMPETITION_SANCTIONED').reasons).toContain(
      'RECOGNITION_PLATFORM_CEILING',
    );
    // Certified through the PLATFORM anchor: V2 holds, but it does not root in the national sanction.
    const notRooted = evalOf(
      produce(v3, (d) => {
        d.attestations = d.attestations!.map((a) =>
          a.claimType === 'RESULT_OFFICIAL'
            ? { ...a, issuerPrincipalId: FIX.platformOfficial, keyId: keyOf(FIX.platformOfficial) }
            : a,
        );
      }),
    );
    expect(notRooted.outcome.highestSatisfiedLevel).toBe('V2');
    expect(criterion(notRooted, 'CERTIFICATION_ROOTED_IN_SANCTION').reasons).toContain(
      'CERTIFICATION_NOT_ROOTED',
    );
  });
  it('RecognitionLevel is never a VerificationLevel (types and values disjoint)', () => {
    expect(VERIFICATION_LEVEL_IS_NOT_RECOGNITION_LEVEL).toBe(true);
    const rec = new Set<string>(Object.values(RecognitionLevel));
    expect(VERIFICATION_LEVELS.some((v) => rec.has(v))).toBe(false);
  });
});

describe('V4 RATIFIED', () => {
  it('V3 alone is not V4; the full set is V4', () => {
    expect(
      level(
        produce(world, (d) => {
          d.ratifications = [];
        }),
      ),
    ).toBe('V3');
    expect(level(world)).toBe('V4');
  });
  it('each mandatory V4 fact matters (no generic Result-ratification shortcut)', () => {
    expect(
      level(
        produce(world, (d) => {
          delete (d as { recordCategory?: unknown }).recordCategory;
        }),
      ),
    ).toBe('V3');
    expect(
      level(
        produce(world, (d) => {
          d.ratifications![0]!.issuerPrincipalType = 'SYSTEM';
        }),
      ),
    ).toBe('V3');
    expect(
      level(
        produce(world, (d) => {
          d.recordCategory!.recognitionLevel = 'CONTINENTAL';
        }),
      ),
    ).toBe('V3');
    expect(
      level(
        produce(world, (d) => {
          d.recordCategory!.requiredConditionAspects = ['WIND', 'ALTITUDE'];
        }),
      ),
    ).toBe('V3');
    expect(
      level(
        produce(world, (d) => {
          d.sanctions![0]!.assurance = 'PLATFORM_WITNESSED';
        }),
      ),
    ).toBe('V3');
    expect(
      level(
        produce(world, (d) => {
          d.supportedFactKinds = d.supportedFactKinds.filter((k) => !k.startsWith('RECORD_'));
        }),
      ),
    ).toBe('V3');
  });
  it('derived copies and unknown provenance never add an independent primary source', () => {
    const derived = produce(world, (d) => {
      d.evidence = [
        d.evidence![0]!,
        {
          ...d.evidence![0]!,
          evidenceId: fixtureId('redacted-copy'),
          contentHash: `sha256:${'c'.repeat(64)}`,
          provenanceRootId: d.evidence![0]!.evidenceId,
        },
      ];
      d.officialEvidenceSet = { evidenceTypes: ['SIGNED_SCORESHEET'] };
    });
    const e = evalOf(derived);
    expect(e.outcome.highestSatisfiedLevel).toBe('V3');
    expect(criterion(e, 'INDEPENDENT_PRIMARY_SOURCES')).toMatchObject({
      status: 'FAIL',
      observed: 1,
    });
    const unknown = produce(world, (d) => {
      delete d.evidence![1]!.sourcePrincipalId;
    });
    expect(criterion(evalOf(unknown), 'INDEPENDENT_PRIMARY_SOURCES').observed).toBe(1);
    // same bytes, different provenance ⇒ still two sources; different items, same source ⇒ one
    const sameBytes = produce(world, (d) => {
      d.evidence![1]!.contentHash = d.evidence![0]!.contentHash;
    });
    expect(level(sameBytes)).toBe('V4');
    const sameSource = produce(world, (d) => {
      d.evidence![1]!.sourcePrincipalId = FIX.official;
    });
    expect(level(sameSource)).toBe('V3');
  });
});

describe('determinism, order independence, no scores', () => {
  const reorder = (s: VerificationSnapshot, seed: number): VerificationSnapshot =>
    produce(s, (d) => {
      d.evidence = shuffle(d.evidence, seed);
      d.attestations = shuffle(d.attestations, seed + 1);
      d.keys = shuffle(d.keys, seed + 2);
      d.authority.grants = shuffle(d.authority.grants, seed + 3);
      d.authority.anchors = shuffle(d.authority.anchors, seed + 4);
      d.authority.principals = shuffle(d.authority.principals, seed + 5);
      d.participation.principals = shuffle(d.participation.principals, seed + 6);
      d.participation.sides = shuffle(d.participation.sides, seed + 7);
      d.supportedFactKinds = shuffle(d.supportedFactKinds, seed + 8);
      d.identityConfirmations = shuffle(d.identityConfirmations, seed + 9);
    });

  it('same snapshot ⇒ byte-identical outcome, outcomeHash and traceHash', () => {
    const a = evalOf(world);
    const b = evalOf(structuredClone(world));
    expect(b.outcomeHash).toBe(a.outcomeHash);
    expect(b.traceHash).toBe(a.traceHash);
    expect(JSON.stringify(b.outcome)).toBe(JSON.stringify(a.outcome));
  });

  it('property: any insertion order ⇒ same snapshot, outcome and trace hashes', () => {
    const base = evalOf(world);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const e = evalOf(reorder(world, seed));
        return (
          e.snapshotHash === base.snapshotHash &&
          e.outcomeHash === base.outcomeHash &&
          e.traceHash === base.traceHash
        );
      }),
      { numRuns: 25 },
    );
  });

  it('property: irrelevant CONTEXT evidence never changes the level; a relevant change changes the hash', () => {
    const base = evalOf(world);
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const e = evalOf(
          produce(world, (d) => {
            for (let i = 0; i < n % 5; i++)
              d.evidence!.push({
                ...d.evidence![0]!,
                evidenceId: fixtureId(`ctx-${n}-${i}`),
                versionRoles: ['CONTEXT'],
                provenanceRootId: fixtureId(`ctx-${n}-${i}`),
              });
          }),
        );
        return e.outcome.highestSatisfiedLevel === base.outcome.highestSatisfiedLevel;
      }),
      { numRuns: 10 },
    );
    const changed = evalOf(
      produce(world, (d) => {
        d.attestations![0]!.issuedAt = fixtureTime(61);
        d.attestations![0]!.signedAt = fixtureTime(61);
      }),
    );
    expect(changed.snapshotHash).not.toBe(base.snapshotHash);
  });

  it('non-canonical input (duplicate set element, unknown member, float, null) is an integrity failure', () => {
    const dup = produce(world, (d) => {
      d.attestations!.push({ ...d.attestations![0]! });
    });
    expect(() => evalOf(dup)).toThrow(
      expect.objectContaining({ code: 'VERIFICATION_INTEGRITY_FAILURE' }),
    );
    for (const bad of [
      { ...world, trustScore: 1 },
      { ...world, resultVersion: { ...world.resultVersion, versionNumber: 1.5 } },
      { ...world, recordCategory: null },
    ])
      expect(() => evalOf(bad as unknown as VerificationSnapshot)).toThrow(
        expect.objectContaining({ code: 'VERIFICATION_INTEGRITY_FAILURE' }),
      );
  });

  it('a policy spec that does not match its recorded hash is an integrity failure', () => {
    const e = () =>
      evalOf(
        produce(world, (d) => {
          d.policy.spec.levels[1]!.criteria[0] = {
            id: 'v1.independent-corroboration',
            kind: 'INDEPENDENT_CORROBORATION',
            params: { minIssuers: 3 },
          };
        }),
      );
    expect(e).toThrow(
      expect.objectContaining({
        code: 'VERIFICATION_INTEGRITY_FAILURE',
        details: { reason: 'POLICY_HASH_MISMATCH' },
      }),
    );
  });

  it('no confidence, score, probability or weight anywhere in outcome, trace or public DTO', () => {
    const e = evalOf(world);
    const text = JSON.stringify([e.outcome, e.trace, publicBody(e.outcome)]);
    expect(text).not.toMatch(
      /"(confidence|score|trustScore|probability|certaintyPercent|sourceWeight|authorityWeight|weight)"/i,
    );
    expect(text).not.toMatch(/Verified ✓/);
  });

  it('public body and statement carry exact labels and no internal identifiers', () => {
    const e = evalOf(referenceCases().find((c) => c.name === 'v1-production-kinds')!.snapshot);
    const body = publicBody(e.outcome);
    expect(body).toMatchObject({
      level: 'V1',
      label: 'Corroborated',
      next: { level: 'V2', label: 'Event Certified' },
    });
    const text = JSON.stringify(body);
    for (const id of [
      FIX.athletePrincipalA,
      FIX.athletePrincipalB,
      FIX.official,
      fixtureId('grant:official'),
      keyOf(FIX.official),
    ])
      expect(text).not.toContain(id);
    expect(
      publicStatement({
        freshness: 'CURRENT',
        evaluationState: 'EVALUATED',
        level: 'V1',
        policy: { code: 'p', version: 1 },
      }),
    ).toBe('Corroborated (V1): current canonical facts satisfy policy p v1 up to this level.');
    expect(
      publicStatement({ freshness: 'STALE', evaluationState: 'EVALUATED', level: 'V3' }),
    ).not.toContain('V3');
  });
});
