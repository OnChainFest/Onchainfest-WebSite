import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateVerification } from '@br/verification';
import { referenceCases } from '@br/verification/fixtures';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockingReasons, deriveAchievements, evidenceCommitmentOf } from './engine';
import { FX, fixtureHash, padelTitleFixture } from './fixtures';
import {
  attachAnchorFact,
  governingRecognitionFromRun,
  governingRecognitionStatement,
} from './governing';
import { referenceTitleRule, validateAchievementRuleSpec, type AchievementRuleSpec } from './rule';
import {
  sealDerivationSnapshot,
  type AchievementDerivationSnapshot,
  type RecognitionLevelValue,
} from './snapshot';

// REFERENCE ENGINE FIXTURE — NOT PERSISTED SPORTING TRUTH (in memory only).
type Scope = {
  recognitionLevel: RecognitionLevelValue[];
  sport?: string[];
  discipline?: string[];
  region?: string[];
};
const titleClaim = (
  level: 'REGIONAL' | 'NATIONAL' | 'CONTINENTAL' | 'WORLD',
  region?: string[],
  name = 'Champion',
): AchievementRuleSpec => ({
  ...referenceTitleRule(FX.padelDv),
  displayName: name,
  requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
  criterion: {
    ...referenceTitleRule(FX.padelDv).criterion,
    recognitionClaim: { level, ...(region === undefined ? {} : { region }) },
  },
});
const codes = (spec: unknown) => {
  const v = validateAchievementRuleSpec(spec);
  return v.ok ? [] : v.issues.map((i) => i.code);
};
// Fictional continental country sets (the authority-scope vocabulary is ISO 3166 codes).
const SOUTH_AMERICA = ['AR', 'BO', 'BR', 'CL', 'CO', 'EC', 'PE', 'PY', 'UY', 'VE'];
const EUROPE = ['DE', 'ES', 'FR', 'IT', 'PT'];
const run = (
  claim: AchievementRuleSpec,
  governing: {
    level: RecognitionLevelValue;
    scope?: Scope | null;
    source?: 'SANCTION' | 'CERTIFICATION';
  } | null,
  sport = 'padel',
) =>
  deriveAchievements(
    padelTitleFixture({
      level: 'V3',
      sport,
      ruleSpec: claim,
      ruleLabel:
        `claim-${claim.criterion.recognitionClaim?.level ?? 'none'}-${(claim.criterion.recognitionClaim?.region ?? []).join('-')}`.toLowerCase(),
      recognition:
        governing === null
          ? null
          : {
              level: governing.level,
              source: governing.source ?? 'SANCTION',
              ...(governing.scope === undefined ? {} : { scope: governing.scope }),
            },
    }),
  );
const nat = (region: string[], sport = ['padel']): Scope => ({
  recognitionLevel: ['NATIONAL'],
  sport,
  region,
});

describe('AC-4 structural recognition claim: level + region + sport by BRT-03 scope containment', () => {
  it('the claim is structural: region required / bounded per level; labels can never widen it', () => {
    expect(codes(titleClaim('NATIONAL', ['CR']))).toEqual([]);
    expect(codes(titleClaim('NATIONAL'))).toContain('RECOGNITION_CLAIM_REGION_REQUIRED');
    expect(codes(titleClaim('NATIONAL', ['CR', 'PE']))).toContain(
      'NATIONAL_CLAIM_NEEDS_ONE_COUNTRY',
    );
    expect(codes(titleClaim('NATIONAL', ['CR-SJ']))).toContain('NATIONAL_CLAIM_NEEDS_ONE_COUNTRY');
    expect(codes(titleClaim('WORLD', ['CR']))).toContain('WORLD_CLAIM_HAS_NO_REGION');
    expect(codes(titleClaim('CONTINENTAL', SOUTH_AMERICA))).toEqual([]);
    expect(
      codes({
        ...titleClaim('NATIONAL', ['CR']),
        requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
      }),
    ).toContain('RECOGNITION_CLAIM_REQUIRES_V3');
    // Label hygiene: a label may not claim more than the structural claim.
    expect(codes(titleClaim('NATIONAL', ['CR'], 'World Champion'))).toContain(
      'DISPLAY_NAME_CLAIMS_RECOGNITION',
    );
    expect(
      codes({ ...referenceTitleRule(FX.padelDv), displayName: 'National Champion' }),
    ).toContain('DISPLAY_NAME_CLAIMS_RECOGNITION');
  });

  it('1 · PLATFORM cannot back a NATIONAL(CR) claim', () => {
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), { level: 'PLATFORM', source: 'CERTIFICATION' }).outcome,
      ),
    ).toEqual(['RECOGNITION_PLATFORM_CANNOT_BACK_CLAIM']);
    expect(blockingReasons(run(titleClaim('NATIONAL', ['CR']), null).outcome)).toEqual([
      'GOVERNING_RECOGNITION_UNAVAILABLE',
    ]);
  });

  it('2 · NATIONAL(CR) backs NATIONAL(CR)', () => {
    const d = run(titleClaim('NATIONAL', ['CR']), { level: 'NATIONAL', scope: nat(['CR']) });
    expect(d.outcome.state).toBe('ISSUABLE');
    expect(
      d.outcome.candidates?.[0]?.candidate.governingAuthority?.recognitionScope?.region,
    ).toEqual(['CR']);
  });

  it('3 · NATIONAL(PE) does NOT back NATIONAL(CR); sibling regions never cross', () => {
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), { level: 'NATIONAL', scope: nat(['PE']) }).outcome,
      ),
    ).toEqual(['RECOGNITION_REGION_NOT_COVERED']);
    expect(
      blockingReasons(
        run(titleClaim('REGIONAL', ['CR-SJ']), {
          level: 'REGIONAL',
          scope: { recognitionLevel: ['REGIONAL'], region: ['CR-A'] },
        }).outcome,
      ),
    ).toEqual(['RECOGNITION_REGION_NOT_COVERED']);
  });

  it('4 · an unknown governing scope fails closed for NATIONAL(CR)', () => {
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), { level: 'NATIONAL', scope: null }).outcome,
      ),
    ).toEqual(['GOVERNING_RECOGNITION_SCOPE_UNKNOWN']);
  });

  it('5 · CONTINENTAL(South America) backs the same continental claim', () => {
    const scope: Scope = {
      recognitionLevel: ['CONTINENTAL'],
      sport: ['padel'],
      region: SOUTH_AMERICA,
    };
    expect(
      run(titleClaim('CONTINENTAL', SOUTH_AMERICA), { level: 'CONTINENTAL', scope }).outcome.state,
    ).toBe('ISSUABLE');
  });

  it('6 · CONTINENTAL(Europe) does not back a South American claim', () => {
    const scope: Scope = { recognitionLevel: ['CONTINENTAL'], sport: ['padel'], region: EUROPE };
    expect(
      blockingReasons(
        run(titleClaim('CONTINENTAL', SOUTH_AMERICA), { level: 'CONTINENTAL', scope }).outcome,
      ),
    ).toEqual(['RECOGNITION_REGION_NOT_COVERED']);
  });

  it('7 · wrong sport: a padel-only authority does not back a tennis title', () => {
    expect(
      blockingReasons(
        run(
          titleClaim('NATIONAL', ['CR']),
          { level: 'NATIONAL', scope: nat(['CR'], ['padel']) },
          'tennis',
        ).outcome,
      ),
    ).toEqual(['RECOGNITION_SPORT_NOT_COVERED']);
    const discipline: Scope = {
      recognitionLevel: ['NATIONAL'],
      discipline: ['beach.*'],
      region: ['CR'],
    };
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), { level: 'NATIONAL', scope: discipline }).outcome,
      ),
    ).toEqual(['RECOGNITION_DISCIPLINE_NOT_COVERED']);
  });

  it('8 · parent / broader scope follows the BRT-03 containment rules exactly', () => {
    // a country covers its subdivisions (region "CR" covers "CR-SJ")
    expect(
      run(titleClaim('REGIONAL', ['CR-SJ']), {
        level: 'NATIONAL',
        scope: { recognitionLevel: ['REGIONAL', 'NATIONAL'], region: ['CR'] },
      }).outcome.state,
    ).toBe('ISSUABLE');
    // a subdivision never covers its country
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), {
          level: 'NATIONAL',
          scope: { recognitionLevel: ['NATIONAL'], region: ['CR-SJ'] },
        }).outcome,
      ),
    ).toEqual(['RECOGNITION_REGION_NOT_COVERED']);
    // an unconstrained region dimension is world-wide (BRT-03: absent = unconstrained)
    expect(
      run(titleClaim('NATIONAL', ['CR']), {
        level: 'NATIONAL',
        scope: { recognitionLevel: ['NATIONAL'] },
      }).outcome.state,
    ).toBe('ISSUABLE');
    // levels are a SET (equality), not a ladder: a WORLD-only authority does not back a NATIONAL claim
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), {
          level: 'WORLD',
          scope: { recognitionLevel: ['WORLD'] },
        }).outcome,
      ),
    ).toEqual(['RECOGNITION_LEVEL_NOT_COVERED']);
    expect(
      run(titleClaim('WORLD'), { level: 'WORLD', scope: { recognitionLevel: ['WORLD'] } }).outcome
        .state,
    ).toBe('ISSUABLE');
    // a REGIONAL sanction never backs a NATIONAL claim even if its anchor lists NATIONAL
    expect(
      blockingReasons(
        run(titleClaim('NATIONAL', ['CR']), {
          level: 'REGIONAL',
          scope: { recognitionLevel: ['REGIONAL', 'NATIONAL'], region: ['CR'] },
        }).outcome,
      ),
    ).toEqual(['RECOGNITION_BELOW_CLAIMED_SCOPE']);
  });

  it('9 · changing the governing region changes the snapshot hash, candidate hash and commitment', () => {
    const claim = titleClaim('REGIONAL', ['CR']);
    const scopeWith = (region: string[]): Scope => ({
      recognitionLevel: ['REGIONAL'],
      region: [...region],
    });
    const cr = run(claim, { level: 'REGIONAL', scope: scopeWith(['CR']) });
    const crAndPe = run(claim, { level: 'REGIONAL', scope: scopeWith(['CR', 'PE']) });
    expect(cr.snapshotHash).not.toBe(crAndPe.snapshotHash);
    expect(cr.outcome.candidates?.[0]?.candidateHash).not.toBe(
      crAndPe.outcome.candidates?.[0]?.candidateHash,
    );
    // determinism: same pinned scope ⇒ same hashes
    expect(run(claim, { level: 'REGIONAL', scope: scopeWith(['CR']) })).toEqual(cr);
  });

  it('10 · the pinned governing decision is a pure function of the immutable run documents; the anchor fact is cross-checked', () => {
    const byName = new Map(referenceCases().map((c) => [c.name, evaluateVerification(c.snapshot)]));
    const decision = (name: string) => {
      const e = byName.get(name);
      if (e === undefined) throw new Error(name);
      return governingRecognitionFromRun({
        satisfiedLevels: e.outcome.satisfiedLevels ?? [],
        criteria: e.trace.criteria,
      });
    };
    expect(decision('v1-production-kinds')).toBeUndefined();
    expect(decision('v2-result-official')?.source).toBe('CERTIFICATION');
    const v3 = decision('v3-sanctioned');
    expect(v3?.source).toBe('SANCTION');
    expect(decision('v3-sanctioned')).toEqual(v3);
    if (v3 === undefined) throw new Error('no decision');
    const scope = {
      recognitionLevel: [...v3.anchorLevels] as RecognitionLevelValue[],
      region: ['CR'],
    };
    const g = attachAnchorFact(v3, {
      factHash: fixtureHash('anchor-fact'),
      recognitionScope: scope,
    });
    expect(g?.recognitionScope?.region).toEqual(['CR']);
    // an anchor fact whose levels disagree with what the pinned trace recorded is refused
    expect(
      attachAnchorFact(v3, {
        factHash: fixtureHash('x'),
        recognitionScope: { recognitionLevel: ['CLUB'] },
      }),
    ).toBeUndefined();
  });

  it('11 · public wording exposes level / region / sport only — never anchor, grant or chain identifiers', () => {
    const d = run(titleClaim('NATIONAL', ['CR']), { level: 'NATIONAL', scope: nat(['CR']) });
    const g = d.outcome.candidates?.[0]?.candidate.governingAuthority;
    if (g === undefined) throw new Error('none');
    const text = governingRecognitionStatement(g.recognitionLevel, g.recognitionScope);
    expect(text).toBe(
      'Backed by an authority recognized at NATIONAL level (region CR; sport padel).',
    );
    expect(text).not.toContain(g.anchorId);
    expect(text).not.toContain(g.anchorFactHash);
    expect(governingRecognitionStatement('PLATFORM')).toMatch(/platform only/);
  });
});

describe('BRT-01 evidenceCommitment', () => {
  it('commits to the pinned run Evidence Bundle; a different evidence/attestation basis changes it', () => {
    const a = deriveAchievements(padelTitleFixture()).outcome.candidates?.[0];
    const s = padelTitleFixture();
    const changed: AchievementDerivationSnapshot = {
      ...s,
      verification: { ...s.verification, evidenceBundleHash: fixtureHash('evidence-bundle:other') },
    };
    const b = deriveAchievements(changed).outcome.candidates?.[0];
    expect(a?.candidate.evidenceCommitment).toMatch(/^sha256:/);
    expect(b?.candidate.evidenceCommitment).not.toBe(a?.candidate.evidenceCommitment);
    expect(b?.candidateHash).not.toBe(a?.candidateHash);
    if (a === undefined) throw new Error('none');
    expect(evidenceCommitmentOf(a.candidate.basis)).toBe(a.candidate.evidenceCommitment);
    expect(a.candidate.basis[0]?.evidenceBundleHash).toBe(fixtureHash('evidence-bundle:rv1:run1'));
  });

  it('a run without an Evidence Bundle reference cannot issue (VERIFICATION_RUN_INCOMPLETE)', () => {
    const s = padelTitleFixture();
    const { evidenceBundleHash: _e, ...rest } = s.verification;
    void _e;
    expect(blockingReasons(deriveAchievements({ ...s, verification: rest }).outcome)).toEqual([
      'VERIFICATION_RUN_INCOMPLETE',
    ]);
  });
});

describe('asOf / cutoff semantics: the cutoff is not a member, and nothing temporal is resolved inside the engine', () => {
  afterEach(() => vi.useRealTimers());

  it('the snapshot schema has no asOf / cutoff / evaluatedAt member of its own', () => {
    const sealed = sealDerivationSnapshot(padelTitleFixture());
    expect(Object.keys(sealed.snapshot).sort()).not.toEqual(expect.arrayContaining(['asOf']));
    expect(JSON.stringify(sealed.snapshot)).not.toMatch(/"(asOf|cutoff|evaluatedAt)"/);
  });

  it('same sealed snapshot ⇒ identical derivation at any wall-clock time (engine reads no clock)', () => {
    const s = padelTitleFixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'));
    const early = deriveAchievements(s);
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'));
    const late = deriveAchievements(s);
    expect(late).toEqual(early);
  });

  it('every temporal input is a hashed fact: changing one changes the snapshot hash', () => {
    const base = sealDerivationSnapshot(padelTitleFixture()).snapshotHash;
    const s = padelTitleFixture();
    const variants: AchievementDerivationSnapshot[] = [
      { ...s, resultVersion: { ...s.resultVersion, submittedAt: '2026-04-02T00:00:00.000Z' } },
      { ...s, verification: { ...s.verification, evaluatedAsOf: '2026-04-02T00:00:00.000Z' } },
      { ...s, verification: { ...s.verification, state: 'STALE' } },
      { ...s, occurrence: { startedAt: '2026-04-02T00:00:00.000Z' } },
      { ...s, rule: { ...s.rule, bindingId: FX.event } },
    ];
    for (const v of variants) expect(sealDerivationSnapshot(v).snapshotHash).not.toBe(base);
  });

  it('source scan: the pure engine modules never touch Date.now / new Date() / process / Math.random', () => {
    for (const f of [
      'engine.ts',
      'rule.ts',
      'snapshot.ts',
      'marks.ts',
      'support.ts',
      'governing.ts',
      'public.ts',
    ]) {
      const src = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8');
      expect(src, f).not.toMatch(/Date\.now\(|new Date\(|process\.|Math\.random/);
    }
  });
});
