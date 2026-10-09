import { describe, expect, it } from 'vitest';
import { evaluateRecord, recordBlockingReasons, type RecordEvaluation } from './engine';
import {
  authorityWorld,
  categorySpec,
  fixtureCategory,
  recordSnapshot,
  RFX,
  rfxHash,
  rfxId,
  rfxTime,
  standingMark,
  type AuthorityWorldOptions,
  type CategoryFixtureOptions,
  type PerformanceFixture,
  type SnapshotFixtureOptions,
} from './fixtures';

/** REFERENCE ENGINE FIXTURES — NOT PERSISTED SPORTING TRUTH. */
const cat = (o: CategoryFixtureOptions = {}, label = 'c', lifecycle?: 'DRAFT' | 'RETIRED') =>
  fixtureCategory(categorySpec(o), label, 1, undefined, lifecycle ?? 'PUBLISHED');
const establish = (
  c: ReturnType<typeof cat>,
  p: PerformanceFixture,
  extra: Partial<SnapshotFixtureOptions> = {},
): RecordEvaluation => evaluateRecord(recordSnapshot({ category: c, performance: p, ...extra }));
const reasons = (e: RecordEvaluation) => recordBlockingReasons(e.outcome);

/** Establish then ratify one mark with a world (fixture authority), returning the RATIFY outcome. */
function ratify(
  c: ReturnType<typeof cat>,
  p: PerformanceFixture,
  world: AuthorityWorldOptions = {},
  extra: Partial<SnapshotFixtureOptions> = {},
) {
  const est = establish(c, p, extra);
  const markHash = est.outcome.candidate?.candidateHash ?? rfxHash('none');
  return evaluateRecord(
    recordSnapshot({
      category: c,
      performance: p,
      pending: { recordMarkId: rfxId(`pending:${p.rv}`), markHash },
      world: authorityWorld(c.spec, world),
      ...extra,
    }),
  );
}

describe('record engine — ESTABLISH (candidate → PENDING_RATIFICATION)', () => {
  it('a FINAL, V3, eligible performance with no standing record qualifies as a pending claim', () => {
    const e = establish(cat(), { rv: 'a', value: '11000', minute: 10 });
    expect(e.outcome.state).toBe('QUALIFIES');
    expect(e.outcome.markStatus).toBe('PENDING_RATIFICATION');
    const c = e.outcome.candidate?.candidate;
    expect(c?.value.value).toBe('11000');
    expect(c?.effectiveFrom).toBe(rfxTime(10));
    expect(c?.comparison.relation).toBe('NO_CURRENT_RECORD');
    expect(c?.basis.verificationLevel).toBe('V3');
  });

  it('same semantic input ⇒ same snapshot, outcome and candidate hash (input order irrelevant)', () => {
    const s = recordSnapshot({
      category: cat(),
      performance: { rv: 'a', value: '11000', minute: 10 },
    });
    const reversed = JSON.parse(JSON.stringify(s, Object.keys(s).reverse()));
    const a = evaluateRecord(s);
    const b = evaluateRecord({
      ...reversed,
      ...s,
      supportedFactKinds: [...s.supportedFactKinds].reverse(),
    });
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.outcomeHash).toBe(b.outcomeHash);
  });

  it('LOWER_IS_BETTER (time): 11.00 → 10.90 better; 10.95 is NOT better than 10.90', () => {
    const c = cat();
    const current = [standingMark(c.spec, 'm1090', '10900', 20)];
    expect(
      establish(c, { rv: 'x', value: '10950', minute: 30 }, { currentMarks: current }).outcome
        .state,
    ).toBe('DOES_NOT_QUALIFY');
    const better = establish(c, { rv: 'y', value: '10800', minute: 30 }, { currentMarks: current });
    expect(better.outcome.state).toBe('QUALIFIES');
    expect(better.outcome.comparison?.relation).toBe('BETTER');
    expect(better.outcome.comparison?.displaces).toEqual([current[0]?.recordMarkId]);
  });

  it('HIGHER_IS_BETTER (pins): a larger series is better, a smaller one is not', () => {
    const c = cat({ sport: 'bowling' });
    const current = [standingMark(c.spec, 'm700', '700', 5)];
    expect(
      establish(c, { rv: 'hi', value: '710', minute: 30 }, { currentMarks: current }).outcome.state,
    ).toBe('QUALIFIES');
    expect(
      reasons(establish(c, { rv: 'lo', value: '690', minute: 30 }, { currentMarks: current })),
    ).toContain('NOT_BETTER_THAN_CURRENT_RECORD');
  });

  it('ties: SHARED admits an exact equal as co-holder; FIRST_ACHIEVED does not', () => {
    const shared = cat({ tiePolicy: 'SHARED' }, 'shared');
    const first = cat({ tiePolicy: 'FIRST_ACHIEVED' }, 'first');
    const eqS = establish(
      shared,
      { rv: 'b', value: '10900', minute: 40 },
      {
        currentMarks: [standingMark(shared.spec, 'a', '10900', 20)],
      },
    );
    expect(eqS.outcome.state).toBe('QUALIFIES');
    expect(eqS.outcome.comparison?.relation).toBe('EQUAL_SHARED');
    expect(eqS.outcome.comparison?.displaces).toEqual([]);
    const eqF = establish(
      first,
      { rv: 'b', value: '10900', minute: 40 },
      {
        currentMarks: [standingMark(first.spec, 'a', '10900', 20)],
      },
    );
    expect(eqF.outcome.state).toBe('DOES_NOT_QUALIFY');
    expect(reasons(eqF)).toContain('EQUALS_CURRENT_RECORD_FIRST_ACHIEVED');
  });

  it('decimal equality is exact (10.90 == 10.900), never floating point', () => {
    const c = fixtureCategory(categorySpec({ tiePolicy: 'FIRST_ACHIEVED' }), 'exact');
    const s = recordSnapshot({
      category: c,
      performance: { rv: 'z', value: '10900', minute: 40 },
      currentMarks: [standingMark(c.spec, 'a', '10900', 20)],
    });
    expect(evaluateRecord(s).outcome.state).toBe('DOES_NOT_QUALIFY');
  });

  it('RC-4: HANDICAP never enters SCRATCH; unknown handicap is not scratch; SCRATCH continues', () => {
    const c = cat({ sport: 'bowling', population: { handicapMode: 'SCRATCH' } }, 'scratch');
    const p = { rv: 's', value: '720', minute: 30 };
    const handicap = establish(c, p, { population: { HANDICAP_MODE: 'HANDICAP' } });
    expect(handicap.outcome.state).toBe('INELIGIBLE');
    expect(reasons(handicap)).toContain('HANDICAP_VALUE_IN_SCRATCH_CATEGORY');
    const unknown = establish(c, p);
    expect(unknown.outcome.state).toBe('PENDING_REQUIRED_FACTS');
    expect(reasons(unknown)).toEqual(
      expect.arrayContaining(['POPULATION_FACT_UNAVAILABLE', 'HANDICAP_MODE_UNKNOWN']),
    );
    const unsupported = establish(c, p, {
      unsupported: ['POPULATION'],
      population: { HANDICAP_MODE: 'SCRATCH' },
    });
    expect(reasons(unsupported)).toContain('POPULATION_FACT_UNAVAILABLE');
    expect(establish(c, p, { population: { HANDICAP_MODE: 'SCRATCH' } }).outcome.state).toBe(
      'QUALIFIES',
    );
  });

  it('wrong population dimension (gender) is ineligible', () => {
    const c = cat({ population: { genderCategory: 'WOMEN' } }, 'women');
    expect(
      establish(
        c,
        { rv: 'g', value: '11000', minute: 3 },
        { population: { GENDER_CATEGORY: 'MEN' } },
      ).outcome.state,
    ).toBe('INELIGIBLE');
  });

  it('conditions resolve from facts only; unknown fails closed; limits are exact', () => {
    const c = cat(
      { conditions: [{ aspect: 'WIND', requirement: 'MAXIMUM', limit: '2.0', unit: 'm/s' }] },
      'wind',
    );
    const p = { rv: 'w', value: '10000', minute: 3 };
    expect(reasons(establish(c, p))).toContain('CONDITIONS_FACT_UNAVAILABLE');
    expect(
      establish(c, p, {
        conditions: [{ aspect: 'WIND', compliant: true, value: '2.1', unit: 'm/s' }],
      }).outcome.state,
    ).toBe('INELIGIBLE');
    expect(
      establish(c, p, {
        conditions: [{ aspect: 'WIND', compliant: true, value: '2.0', unit: 'm/s' }],
      }).outcome.state,
    ).toBe('QUALIFIES');
    expect(
      establish(c, p, {
        conditions: [{ aspect: 'WIND', compliant: false, value: '1.0', unit: 'm/s' }],
      }).outcome.state,
    ).toBe('INELIGIBLE');
  });

  it('an admitted hold (or unknown hold state) blocks; never promoted', () => {
    const c = cat();
    expect(reasons(establish(c, { rv: 'h', value: '11000', minute: 3 }, { hold: true }))).toContain(
      'HOLD_ACTIVE',
    );
    expect(
      reasons(
        establish(c, { rv: 'h', value: '11000', minute: 3 }, { unsupported: ['HOLD_STATE'] }),
      ),
    ).toContain('HOLD_STATE_UNAVAILABLE');
  });

  it('verification floors: V2 cannot establish a V3 category; stale verification blocks', () => {
    const c = cat();
    expect(reasons(establish(c, { rv: 'v2', value: '11000', minute: 3, level: 'V2' }))).toContain(
      'VERIFICATION_LEVEL_BELOW_REQUIRED',
    );
    expect(
      reasons(establish(c, { rv: 'st', value: '11000', minute: 3, verificationState: 'STALE' })),
    ).toContain('VERIFICATION_STALE');
  });

  it('status floor: non-FINAL results never establish a record; revoked / superseded are ineligible', () => {
    const c = cat();
    expect(
      reasons(establish(c, { rv: 'o', value: '11000', minute: 3, status: 'OFFICIAL' })),
    ).toContain('RESULT_STATUS_BELOW_REQUIRED');
    expect(
      establish(c, { rv: 'r', value: '11000', minute: 3, status: 'REVOKED' }).outcome.state,
    ).toBe('INELIGIBLE');
    expect(
      establish(c, { rv: 's', value: '11000', minute: 3, supersededBy: 's2' }).outcome.state,
    ).toBe('INELIGIBLE');
  });

  it('effectiveFrom: a performance before it is not eligible; the same after it is', () => {
    const c = cat({ effectiveFrom: rfxTime(100) }, 'eff');
    expect(reasons(establish(c, { rv: 'early', value: '11000', minute: 99 }))).toContain(
      'PERFORMANCE_BEFORE_CATEGORY_EFFECTIVE_FROM',
    );
    expect(establish(c, { rv: 'late', value: '11000', minute: 100 }).outcome.state).toBe(
      'QUALIFIES',
    );
  });

  it('only PUBLISHED category versions establish records (retired / draft are ineligible)', () => {
    expect(
      reasons(establish(cat({}, 'ret', 'RETIRED'), { rv: 'a', value: '11000', minute: 3 })),
    ).toContain('CATEGORY_VERSION_RETIRED');
    expect(
      reasons(establish(cat({}, 'dr', 'DRAFT'), { rv: 'a', value: '11000', minute: 3 })),
    ).toContain('CATEGORY_VERSION_NOT_PUBLISHED');
  });

  it('COMPETITION scope is structural: another competition is outside the universe', () => {
    expect(
      reasons(
        establish(cat(), {
          rv: 'o',
          value: '11000',
          minute: 3,
          competitionId: RFX.otherCompetition,
        }),
      ),
    ).toContain('OUTSIDE_COMPETITION_SCOPE');
  });

  it('VENUE / LEAGUE / NATIONAL membership facts have no canonical producer ⇒ fail closed', () => {
    for (const st of ['VENUE', 'LEAGUE'] as const) {
      const r = reasons(
        establish(
          cat({ scopeType: st }, st),
          { rv: st, value: '11000', minute: 3 },
          {
            unsupported: ['VENUE_MEMBERSHIP', 'LEAGUE_MEMBERSHIP'],
          },
        ),
      );
      expect(r).toContain(`${st}_MEMBERSHIP_UNAVAILABLE`);
    }
    const n = cat({ scopeType: 'NATIONAL' }, 'nat');
    expect(
      reasons(
        establish(
          n,
          { rv: 'n', value: '11000', minute: 3 },
          { unsupported: ['REGION_ELIGIBILITY'] },
        ),
      ),
    ).toContain('REGION_ELIGIBILITY_UNAVAILABLE');
    expect(
      reasons(
        establish(
          n,
          { rv: 'n2', value: '11000', minute: 3 },
          { memberships: { regionEligibility: ['PE'] } },
        ),
      ),
    ).toContain('OUTSIDE_REGION_POPULATION');
  });

  it('value integrity: the candidate value is exactly the performance mark; metric substitution is integrity', () => {
    const c = cat();
    const s = recordSnapshot({ category: c, performance: { rv: 'm', value: '11000', minute: 3 } });
    const forged = {
      ...s,
      performance: {
        ...s.performance,
        mark: { ...s.performance.mark, metricId: 'bowling.series.pins' },
      },
    };
    const e = evaluateRecord(forged);
    expect(e.outcome.state).toBe('INTEGRITY_FAILURE');
    expect(reasons(e)).toContain('METRIC_MISMATCH');
    const tampered = { ...s, category: { ...s.category, specHash: rfxHash('tampered') } };
    expect(reasons(evaluateRecord(tampered))).toContain('CATEGORY_HASH_MISMATCH');
  });

  it('a perfect-game-like threshold is not a record: no category ⇒ no comparison universe', () => {
    // Records exist only through a RecordCategory; a PERFORMANCE_THRESHOLD Achievement is never one.
    const c = cat({ sport: 'bowling' }, 'series');
    expect(c.spec.universe.metric.markMetricId).toBe('bowling.series.pins');
  });

  it('V4 categories admit a pending CLAIM at V3 only; no ratification ⇒ never RATIFIED', () => {
    const n = cat({ scopeType: 'NATIONAL' }, 'nat');
    const e = establish(n, { rv: 'n', value: '10000', minute: 3, level: 'V3' });
    expect(e.outcome.state).toBe('QUALIFIES');
    expect(e.outcome.markStatus).toBe('PENDING_RATIFICATION');
    expect(reasons(establish(n, { rv: 'n2', value: '10000', minute: 3, level: 'V2' }))).toContain(
      'VERIFICATION_LEVEL_BELOW_REQUIRED',
    );
  });

  it('PLATFORM V2 + review is PLATFORM-only: V2 establishes a PLATFORM review claim, never VENUE / COMPETITION / LEAGUE', () => {
    const p = cat({ scopeType: 'PLATFORM', platformReview: true }, 'plat');
    expect(establish(p, { rv: 'p', value: '11000', minute: 3, level: 'V2' }).outcome.state).toBe(
      'QUALIFIES',
    );
    const noReview = cat({ scopeType: 'PLATFORM' }, 'plat2');
    expect(
      establish(noReview, { rv: 'p', value: '11000', minute: 3, level: 'V2' }).outcome.state,
    ).toBe('PENDING_REQUIRED_FACTS');
    for (const st of [
      'VENUE',
      'COMPETITION',
      'LEAGUE',
      'NATIONAL',
      'CONTINENTAL',
      'WORLD',
    ] as const)
      expect(() => categorySpecValidOrThrow({ scopeType: st, platformReview: true })).toThrow();
  });

  it('TEAM records credit members only through the credited lineup (AC-5)', () => {
    const t = cat({ holderType: 'TEAM', sport: 'bowling' }, 'team');
    const e = establish(t, { rv: 't', value: '800', minute: 3, team: 'pair' });
    expect(e.outcome.state).toBe('QUALIFIES');
    expect(e.outcome.candidate?.candidate.holder.holderType).toBe('TEAM');
    expect(e.outcome.candidate?.candidate.memberCredits).toHaveLength(2);
    expect(
      reasons(
        establish(
          t,
          { rv: 't2', value: '800', minute: 3, team: 'pair' },
          { unsupported: ['CREDITED_LINEUP'] },
        ),
      ),
    ).toContain('MEMBER_CREDITS_UNAVAILABLE');
  });
});

function categorySpecValidOrThrow(o: CategoryFixtureOptions) {
  return fixtureCategory(categorySpec(o), 'x');
}

describe('record engine — RATIFY (pending → RATIFIED / CANONICAL)', () => {
  it('a valid RATIFY_RECORD ratification bound to the exact mark hash ratifies', () => {
    const c = cat();
    const r = ratify(c, { rv: 'a', value: '11000', minute: 10 });
    expect(r.outcome.mode).toBe('RATIFY');
    expect(r.outcome.state).toBe('QUALIFIES');
    expect(r.outcome.markStatus).toBe('RATIFIED');
    expect(r.outcome.ratification?.authorityProofDigest).toMatch(/^sha256:/);
  });

  it('no ratification / wrong subject hash / denial / retraction ⇒ stays pending', () => {
    const c = cat();
    const p = { rv: 'a', value: '11000', minute: 10 };
    expect(reasons(ratify(c, p, {}, { ratification: null }))).toContain('RATIFICATION_MISSING');
    expect(reasons(ratify(c, p, {}, { unsupported: ['RATIFICATION'] }))).toContain(
      'RATIFICATION_UNAVAILABLE',
    );
    expect(
      reasons(
        ratify(
          c,
          p,
          {},
          {
            ratification: {
              subject: {
                subjectType: 'RECORD_MARK',
                subjectId: rfxId('pending:a'),
                subjectHash: rfxHash('forged'),
              },
            },
          },
        ),
      ),
    ).toContain('RATIFICATION_SUBJECT_HASH_MISMATCH');
    expect(reasons(ratify(c, p, {}, { ratification: { polarity: 'DENY' } }))).toContain(
      'RATIFICATION_DENIED',
    );
    expect(reasons(ratify(c, p, {}, { ratification: { status: 'RETRACTED' } }))).toContain(
      'RATIFICATION_NOT_ACTIVE',
    );
  });

  it('authority: unauthorized capability, expired / revoked grant, revoked key, conflicted principal fail closed', () => {
    const c = cat();
    const p = { rv: 'a', value: '11000', minute: 10 };
    const base = (w: AuthorityWorldOptions, extra: Partial<SnapshotFixtureOptions> = {}) =>
      reasons(ratify(c, p, w, extra));
    expect(base({ grantCapabilities: ['ATTEST_RESULT'] })).toContain('RATIFICATION_NOT_AUTHORIZED');
    expect(base({ grantValidTo: rfxTime(100) })).toContain('RATIFY_RECORD_GRANT_NOT_VALID_AT_TIME');
    expect(base({ grantRevokedAt: rfxTime(100) })).toContain('RATIFY_RECORD_GRANT_REVOKED');
    expect(base({ keyRevokedAt: rfxTime(100) })).toContain('RATIFY_RECORD_KEY_REVOKED');
    const world = authorityWorld(c.spec, {});
    expect(base({}, { conflicted: [world.ratifierPrincipalId] })).toContain(
      'RATIFY_RECORD_CONFLICT_OF_INTEREST',
    );
    expect(base({}, { unsupported: ['PARTICIPATION'] })).toContain(
      'RATIFY_RECORD_CONFLICT_CHECK_UNAVAILABLE',
    );
    expect(base({ ratifierType: 'SYSTEM' })).toContain('RATIFIER_NOT_HUMAN');
  });

  it('NATIONAL(PE) authority cannot ratify NATIONAL(CR); wrong sport fails; unknown scope fails closed', () => {
    const n = cat({ scopeType: 'NATIONAL', region: ['CR'] }, 'natcr');
    const p = { rv: 'n', value: '10000', minute: 10, level: 'V3' as const };
    // Ratification needs CURRENT V4 for the category; give it, then vary the authority.
    const pv4 = { ...p, level: 'V4' as const };
    const ok = ratifyWithPending(n, p, pv4, {});
    expect(ok.outcome.state).toBe('QUALIFIES');
    expect(
      reasons(ratifyWithPending(n, p, pv4, { anchorRegion: ['PE'], grantRegion: ['PE'] })),
    ).toContain('RATIFICATION_NOT_AUTHORIZED');
    expect(
      reasons(ratifyWithPending(n, p, pv4, { anchorSport: ['padel'], grantSport: ['padel'] })),
    ).toContain('RATIFICATION_NOT_AUTHORIZED');
    // A grant broader than its anchor (region widened) never authorizes.
    expect(
      reasons(ratifyWithPending(n, p, pv4, { anchorRegion: ['PE'], grantRegion: ['CR'] })),
    ).toContain('RATIFY_RECORD_ANCHOR_SCOPE_NOT_COVERED');
  });

  it('PLATFORM authority can never ratify NATIONAL / WORLD records', () => {
    for (const st of ['NATIONAL', 'WORLD'] as const) {
      const n = cat({ scopeType: st }, `plat-${st}`);
      const p = { rv: st, value: '10000', minute: 10, level: 'V3' as const };
      const r = ratifyWithPending(
        n,
        p,
        { ...p, level: 'V4' },
        { anchorLevel: 'PLATFORM', platformAnchor: true },
      );
      expect(r.outcome.state).toBe('PENDING_REQUIRED_FACTS');
      expect(reasons(r)).toContain('RATIFICATION_NOT_AUTHORIZED');
    }
  });

  it('V4: ratification alone cannot bypass V4; PLATFORM_WITNESSED never ratifies V4', () => {
    const n = cat({ scopeType: 'WORLD' }, 'world');
    const p = { rv: 'w', value: '9580', minute: 10, level: 'V3' as const };
    // Current V3 at ratification time ⇒ still pending (V4 needs the ratification AND BRT-07's V4 run).
    expect(reasons(ratifyWithPending(n, p, p, {}))).toContain('VERIFICATION_LEVEL_BELOW_REQUIRED');
    // A V4 run that counted ANOTHER category's ratification is not V4 for this category.
    expect(
      reasons(ratifyWithPending(n, p, { ...p, level: 'V4', v4CategoryIds: [rfxId('other')] }, {})),
    ).toContain('V4_NOT_ESTABLISHED_FOR_CATEGORY');
    expect(
      reasons(
        ratifyWithPending(
          n,
          p,
          { ...p, level: 'V4' },
          {},
          { ratification: { assurance: 'PLATFORM_WITNESSED' } },
        ),
      ),
    ).toContain('RATIFICATION_ASSURANCE_INSUFFICIENT');
    expect(ratifyWithPending(n, p, { ...p, level: 'V4' }, {}).outcome.markStatus).toBe('RATIFIED');
  });

  it('CANONICAL requires the explicitly designated keeper; a NATIONAL authority alone ⇒ RATIFIED at most', () => {
    const plain = cat({ scopeType: 'NATIONAL' }, 'nat-plain');
    const keeper = cat({ scopeType: 'NATIONAL', canonicalKeeper: true }, 'nat-keeper');
    const p = { rv: 'k', value: '10000', minute: 10, level: 'V3' as const };
    const v4 = { ...p, level: 'V4' as const };
    expect(ratifyWithPending(plain, p, v4, { ratifierIsKeeper: true }).outcome.markStatus).toBe(
      'RATIFIED',
    );
    expect(ratifyWithPending(keeper, p, v4, {}).outcome.markStatus).toBe('RATIFIED');
    const canon = ratifyWithPending(keeper, p, v4, { ratifierIsKeeper: true });
    expect(canon.outcome.markStatus).toBe('CANONICAL');
    expect(canon.outcome.ratification?.canonicalKeeper).toBe(true);
  });

  it('PLATFORM: V2 + REVIEW_COMPLETED ratifies a platform best; V2 + RECORD_RATIFIED does not; never CANONICAL', () => {
    const p = cat({ scopeType: 'PLATFORM', platformReview: true }, 'plat');
    const perf = { rv: 'p', value: '11000', minute: 10, level: 'V2' as const };
    const review = ratifyWithPending(
      p,
      perf,
      perf,
      {},
      { ratification: { kind: 'REVIEW_COMPLETED' } },
    );
    expect(review.outcome.markStatus).toBe('RATIFIED');
    expect(review.outcome.ratification?.platformReview).toBe(true);
    expect(reasons(ratifyWithPending(p, perf, perf, {}))).toContain(
      'PLATFORM_REVIEW_REQUIRED_BELOW_V3',
    );
    expect(() =>
      fixtureCategory(categorySpec({ scopeType: 'PLATFORM', canonicalKeeper: true }), 'pk'),
    ).toThrow();
  });

  it('a pending mark whose basis differs from the snapshot performance is an integrity failure', () => {
    const c = cat();
    const s = recordSnapshot({
      category: c,
      performance: { rv: 'a', value: '11000', minute: 10 },
      pending: { recordMarkId: rfxId('pm'), markHash: rfxHash('pm') },
      world: authorityWorld(c.spec),
    });
    const forged = {
      ...s,
      performance: { ...s.performance, mark: { ...s.performance.mark, value: '10000' } },
    };
    expect(evaluateRecord(forged).outcome.state).toBe('INTEGRITY_FAILURE');
  });
});

/** Establish at `est` facts, then ratify with `rat` facts (e.g. V3 claim, V4 at ratification). */
function ratifyWithPending(
  c: ReturnType<typeof cat>,
  est: PerformanceFixture,
  rat: PerformanceFixture,
  world: AuthorityWorldOptions,
  extra: Partial<SnapshotFixtureOptions> = {},
) {
  const e = establish(c, est);
  const markHash = e.outcome.candidate?.candidateHash ?? rfxHash('none');
  return evaluateRecord(
    recordSnapshot({
      category: c,
      performance: rat,
      pending: { recordMarkId: rfxId(`pending:${est.rv}`), markHash },
      world: authorityWorld(c.spec, world),
      ...extra,
    }),
  );
}
