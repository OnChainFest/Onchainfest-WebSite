import {
  deriveAchievements,
  referencePersonalBestRule,
  referenceThresholdRule,
  referenceTitleRule,
  sealDerivationSnapshot,
  type AchievementDerivationSnapshot,
  type SupportFacts,
} from '@br/achievements';
import {
  FX,
  fixtureHash,
  fixtureId,
  padelTitleFixture,
  personalBestFixture,
  thresholdFixture,
  type FixtureOptions,
  type FixtureRuleIdentity,
} from '@br/achievements/fixtures';
import {
  createFixturePersistenceEnvironment,
  FIXTURE_ENVIRONMENT_BANNER,
  publishAchievementRule,
  type FixturePersistenceEnvironment,
} from '@br/testkit/achievements';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  liveSupport,
  persistDerivation,
  recordSupportAssessment,
  sweepSupport,
  validateCandidate,
  type SupportFactSource,
} from './achievement-lanes';
import {
  rebuildAchievementReadModels,
  snapshotAchievementReadModels,
} from './achievement-projection';
import {
  AchievementPublicReader,
  dependencyIndex,
  publicGoverningRecognition,
} from './achievement-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *  REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH
 *  Throwaway databases (br_achfx_<hex>), destroyed after the suite. The overlay relaxes ONLY the
 *  Achievement provenance CHECKs; no upstream canonical table receives a synthetic fact. These tests
 *  prove BRT-08's OWN persistence mechanics, not a production sporting flow.
 * ════════════════════════════════════════════════════════════════════════════════════════════
 */
let env: FixturePersistenceEnvironment;
let titleRule: FixtureRuleIdentity;
let thresholdRule: FixtureRuleIdentity;
let pbRule: FixtureRuleIdentity;

beforeAll(async () => {
  env = await createFixturePersistenceEnvironment({ overlay: true });
  titleRule = await publishAchievementRule(
    env.rules,
    env.operatorAccountId,
    referenceTitleRule(env.dv.padel),
  );
  thresholdRule = await publishAchievementRule(
    env.rules,
    env.operatorAccountId,
    referenceThresholdRule(
      env.dv.bowling,
      { key: 'score', markMetricId: 'score' },
      'GTE',
      '300',
      'Perfect Game',
    ),
  );
  pbRule = await publishAchievementRule(
    env.rules,
    env.operatorAccountId,
    referencePersonalBestRule(env.dv.running, {
      key: 'elapsedTimeMs',
      markMetricId: 'elapsed_time_ms',
    }),
  );
}, 180_000);
afterAll(async () => {
  await env?.destroy();
});

const title = (o: FixtureOptions & { ranks?: { a: number; b: number }; lineupA?: string[] } = {}) =>
  padelTitleFixture({
    ...o,
    disciplineVersionId: env.dv.padel,
    ruleSpec: referenceTitleRule(env.dv.padel),
    ruleIdentity: titleRule,
  });
const threshold = (o: FixtureOptions & { value?: string } = {}) =>
  thresholdFixture({
    ...o,
    disciplineVersionId: env.dv.bowling,
    dv: env.dv.bowling,
    ruleSpec: referenceThresholdRule(
      env.dv.bowling,
      { key: 'score', markMetricId: 'score' },
      'GTE',
      '300',
      'Perfect Game',
    ),
    ruleIdentity: thresholdRule,
  });
const persist = (snapshot: AchievementDerivationSnapshot) =>
  persistDerivation(env.api, { snapshot });
const q = async <T>(text: ReturnType<typeof sql<T>>) => (await text.execute(env.owner)).rows;
const status = async (id: string) =>
  (
    await q(
      sql<{
        status: string;
        reasons: string[];
      }>`SELECT status, status_reasons AS reasons FROM achievement_read.achievement_card WHERE achievement_id = ${id}`,
    )
  )[0];
const one = async (snapshot: AchievementDerivationSnapshot) => {
  const r = await persist(snapshot);
  const a = r.achievements[0];
  if (a === undefined) throw new Error(`nothing persisted: ${r.blockedBy.join(',')}`);
  return a;
};
const support = (
  achievementId: string,
  rv: string,
  run: string,
  over: Partial<Omit<SupportFacts, 'basis'>> & {
    basis?: Partial<SupportFacts['basis'][number]>;
  } = {},
): SupportFacts => {
  const { basis, ...rest } = over;
  return {
    provenance: 'REFERENCE_FIXTURE',
    achievementId,
    requiredLevel: 'V2',
    basis: [
      {
        resultVersionId: fixtureId(`result-version:${rv}`),
        pinnedRunId: fixtureId(`run:${run}`),
        status: 'FINAL',
        verification: {
          state: 'CURRENT',
          runId: fixtureId(`run:${run}`),
          snapshotHash: fixtureHash(`verification-snapshot:${run}`),
          outcomeHash: fixtureHash(`verification-outcome:${run}`),
          level: 'V2',
        },
        ...basis,
      },
    ],
    holdSupported: true,
    holdActive: false,
    ...rest,
  };
};

describe('hard boundary: normal schema rejects, throwaway overlay accepts (separate databases)', () => {
  it('NORMAL migrated schema (fresh throwaway DB, NO overlay): REFERENCE_FIXTURE persistence is rejected by the database', async () => {
    const normal = await createFixturePersistenceEnvironment({ overlay: false });
    try {
      const r = await publishAchievementRule(
        normal.rules,
        normal.operatorAccountId,
        referenceTitleRule(normal.dv.padel),
      );
      const snapshot = padelTitleFixture({
        disciplineVersionId: normal.dv.padel,
        ruleSpec: referenceTitleRule(normal.dv.padel),
        ruleIdentity: r,
      });
      await expect(persistDerivation(normal.api, { snapshot })).rejects.toMatchObject({
        code: '23514',
        constraint: 'achievement_canonical_provenance_only',
      });
    } finally {
      await normal.destroy();
    }
  }, 180_000);

  it('THROWAWAY DB WITH TEST-ONLY OVERLAY: the same derivation persists through the validated path', async () => {
    expect(FIXTURE_ENVIRONMENT_BANNER).toContain('NOT CANONICAL SPORTING TRUTH');
    expect(env.database).toMatch(/^br_achfx_[0-9a-f]{12}$/);
    const a = await one(title({ rv: 'boundary' }));
    expect(a.created).toBe(true);
  });
});

describe('TEAM title: ONE canonical TEAM Achievement + immutable memberCredits (BRT-01 §8.1, AC-5)', () => {
  it('1 Achievement for Pair A, credits exactly A1 and A2; nobody else; passport projection for both', async () => {
    const r = await persist(title({ rv: 'title1' }));
    expect(r.achievements).toHaveLength(1);
    const a = r.achievements[0];
    if (a === undefined) throw new Error('none');
    expect(a.holder).toEqual({ holderType: 'TEAM', holderId: FX.teamA });
    expect([...a.memberCredits].sort()).toEqual([FX.athleteA1, FX.athleteA2].sort());
    const rows = await q(
      sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE id = ${a.achievementId}`,
    );
    expect(rows[0]?.n).toBe(1);
    const credits = await q(
      sql<{
        athlete_id: string;
      }>`SELECT athlete_id FROM achievement.member_credit WHERE achievement_id = ${a.achievementId} ORDER BY athlete_id`,
    );
    expect(credits.map((c) => c.athlete_id)).toEqual([FX.athleteA1, FX.athleteA2].sort());
    const passport = await q(sql<{ athlete_id: string; credit_type: string }>`
      SELECT athlete_id, credit_type FROM achievement_read.athlete_achievement WHERE achievement_id = ${a.achievementId} ORDER BY athlete_id`);
    expect(passport).toEqual(
      [FX.athleteA1, FX.athleteA2]
        .sort()
        .map((athlete_id) => ({ athlete_id, credit_type: 'TEAM_MEMBER' })),
    );
    for (const never of [FX.unusedRosterAthlete, FX.athleteB1, FX.athleteB2, FX.teamB]) {
      const n = await q(
        sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM achievement_read.athlete_achievement WHERE athlete_id = ${never}`,
      );
      expect(n[0]?.n).toBe(0);
    }
    // No ATHLETE copy was manufactured for display.
    const athleteRows = await q(
      sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE holder_type = 'ATHLETE' AND holder_id IN (${FX.athleteA1}, ${FX.athleteA2})`,
    );
    expect(athleteRows[0]?.n).toBe(0);
  });

  it('repeat ⇒ the same logical Achievement (natural identity)', async () => {
    const a = await one(title({ rv: 'title-repeat' }));
    const b = await one(title({ rv: 'title-repeat' }));
    expect(b.created).toBe(false);
    expect(b.achievementId).toBe(a.achievementId);
  });

  it('20 concurrent derivations ⇒ 1 TEAM Achievement, 2 member credits, 1 basis item, no raw errors', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => persist(title({ rv: 'title-concurrent' }))),
    );
    const ids = new Set(results.flatMap((r) => r.achievements.map((a) => a.achievementId)));
    expect(ids.size).toBe(1);
    expect(results.flatMap((r) => r.achievements).filter((a) => a.created)).toHaveLength(1);
    const [id] = [...ids];
    const n = await q(sql<{ a: number; c: number; b: number; s: number }>`
      SELECT (SELECT count(*)::int FROM achievement.achievement WHERE id = ${id}) AS a,
             (SELECT count(*)::int FROM achievement.member_credit WHERE achievement_id = ${id}) AS c,
             (SELECT count(*)::int FROM achievement.basis_item WHERE achievement_id = ${id}) AS b,
             (SELECT count(*)::int FROM achievement.status_entry WHERE achievement_id = ${id}) AS s`);
    expect(n[0]).toEqual({ a: 1, c: 2, b: 1, s: 1 });
  });

  it('V1 blocks the V2 title; STALE blocks; verification upgrade later creates it exactly once', async () => {
    expect((await persist(title({ rv: 'upgrade', level: 'V1' }))).blockedBy).toEqual([
      'VERIFICATION_LEVEL_BELOW_REQUIRED',
    ]);
    expect((await persist(title({ rv: 'upgrade', verificationState: 'STALE' }))).blockedBy).toEqual(
      ['VERIFICATION_STALE'],
    );
    const a = await one(title({ rv: 'upgrade', run: 'upgrade:run2' }));
    expect(a.created).toBe(true);
    expect((await one(title({ rv: 'upgrade', run: 'upgrade:run2' }))).created).toBe(false);
  });
});

describe('dependency index, corrections, revocation, downgrade (history never rewritten)', () => {
  it('answers: which Achievements depend on ResultVersion X / VerificationRun Y / Performance Z', async () => {
    const t = await one(title({ rv: 'dep' }));
    const p = await one(threshold({ rv: 'dep-perf' }));
    await inTransaction(env.api, ModuleRole.achievements, async (ctx) => {
      expect(
        (await dependencyIndex(ctx, { resultVersionId: fixtureId('result-version:dep') })).map(
          (x) => x.achievementId,
        ),
      ).toEqual([t.achievementId]);
      expect(
        (await dependencyIndex(ctx, { verificationRunId: fixtureId('run:dep:run1') })).map(
          (x) => x.achievementId,
        ),
      ).toEqual([t.achievementId]);
      const perf = await dependencyIndex(ctx, {
        resultVersionId: fixtureId('result-version:dep-perf'),
        participantId: FX.bowlerParticipant,
        performanceOrdinal: 2,
      });
      expect(perf.map((x) => x.achievementId)).toEqual([p.achievementId]);
    });
  });

  it('correction that still qualifies: NEW Achievement with the new basis supersedes the old; old row unchanged', async () => {
    const a = await one(title({ rv: 'corr1' }));
    const before = await q(
      sql<{
        candidate_hash: string;
        candidate: unknown;
      }>`SELECT candidate_hash, candidate FROM achievement.achievement WHERE id = ${a.achievementId}`,
    );
    const b = await one(title({ rv: 'corr2', supersedes: 'corr1' }));
    expect(b.supersedes).toEqual([a.achievementId]);
    expect(await status(a.achievementId)).toMatchObject({
      status: 'SUPERSEDED',
      reasons: ['REPLACED_BY_NEWER_BASIS'],
    });
    expect(await status(b.achievementId)).toMatchObject({ status: 'ACTIVE' });
    const after = await q(
      sql<{
        candidate_hash: string;
        candidate: unknown;
      }>`SELECT candidate_hash, candidate FROM achievement.achievement WHERE id = ${a.achievementId}`,
    );
    expect(after).toEqual(before);
    const basis = await q(
      sql<{
        rv: string;
      }>`SELECT result_version_id AS rv FROM achievement.basis_item WHERE achievement_id = ${b.achievementId}`,
    );
    expect(basis[0]?.rv).toBe(fixtureId('result-version:corr2'));
  });

  it('corrected lineup: a new Achievement with the corrected memberCredits; old credits untouched', async () => {
    const a = await one(title({ rv: 'lineup1' }));
    const b = await one(
      title({
        rv: 'lineup2',
        supersedes: 'lineup1',
        lineupA: [FX.athleteA1, FX.unusedRosterAthlete],
      }),
    );
    expect([...b.memberCredits].sort()).toEqual([FX.athleteA1, FX.unusedRosterAthlete].sort());
    const old = await q(
      sql<{
        athlete_id: string;
      }>`SELECT athlete_id FROM achievement.member_credit WHERE achievement_id = ${a.achievementId} ORDER BY athlete_id`,
    );
    expect(old.map((x) => x.athlete_id)).toEqual([FX.athleteA1, FX.athleteA2].sort());
    expect((await status(a.achievementId))?.status).toBe('SUPERSEDED');
  });

  it('correction where the holder no longer qualifies: old REVOKED, the new holder gets a new Achievement', async () => {
    const a = await one(title({ rv: 'flip1' }));
    const b = await one(title({ rv: 'flip2', supersedes: 'flip1', ranks: { a: 2, b: 1 } }));
    expect(b.holder.holderId).toBe(FX.teamB);
    expect(b.supersedes).toEqual([]);
    const r = await recordSupportAssessment(
      env.api,
      support(a.achievementId, 'flip1', 'flip1:run1', {
        basis: { supersededByVersionId: fixtureId('result-version:flip2') },
        successorDerivation: 'HOLDER_DOES_NOT_QUALIFY',
      }),
    );
    expect(r).toMatchObject({ changed: true, previous: 'ACTIVE', status: 'REVOKED' });
  });

  it('revocation: historical row kept; current support REVOKED; no replacement; terminal', async () => {
    const a = await one(title({ rv: 'rev1' }));
    const r = await recordSupportAssessment(
      env.api,
      support(a.achievementId, 'rev1', 'rev1:run1', { basis: { status: 'REVOKED' } }),
    );
    expect(r.status).toBe('REVOKED');
    expect((await status(a.achievementId))?.reasons).toEqual(['BASIS_RESULT_REVOKED']);
    const again = await recordSupportAssessment(
      env.api,
      support(a.achievementId, 'rev1', 'rev1:run1'),
    );
    expect(again).toMatchObject({ changed: false, status: 'REVOKED' });
    const n = await q(
      sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE id = ${a.achievementId}`,
    );
    expect(n[0]?.n).toBe(1);
  });

  it('key compromise ⇒ current verification falls to V1: SUSPENDED (not deleted); recovery appends ACTIVE', async () => {
    const a = await one(title({ rv: 'kc1' }));
    const down = await recordSupportAssessment(
      env.api,
      support(a.achievementId, 'kc1', 'kc1:run1', {
        basis: {
          verification: {
            state: 'CURRENT',
            runId: fixtureId('run:kc1:run2'),
            level: 'V1',
            snapshotHash: fixtureHash('x'),
            outcomeHash: fixtureHash('y'),
          },
        },
      }),
    );
    expect(down.status).toBe('SUSPENDED');
    expect((await status(a.achievementId))?.reasons).toEqual([
      'VERIFICATION_RUN_NO_LONGER_CURRENT',
    ]);
    const pub = await new AchievementPublicReader(env.api).achievement(a.achievementId);
    expect(pub).toBeUndefined(); // fixture rows are never served by the public path
    const up = await recordSupportAssessment(env.api, support(a.achievementId, 'kc1', 'kc1:run1'));
    expect(up).toMatchObject({ changed: true, previous: 'SUSPENDED', status: 'ACTIVE' });
    const entries = await q(
      sql<{
        status: string;
      }>`SELECT status FROM achievement.status_entry WHERE achievement_id = ${a.achievementId} ORDER BY seq`,
    );
    expect(entries.map((e) => e.status)).toEqual(['ACTIVE', 'SUSPENDED', 'ACTIVE']);
  });
});

describe('threshold and personal best persist with exact qualifying values', () => {
  it('perfect game: qualifyingValue stored exactly equals the source Performance mark; 299 persists nothing', async () => {
    const a = await one(threshold({ rv: 'pg1' }));
    const row = await q(
      sql<{
        qualifying_value: unknown;
      }>`SELECT qualifying_value FROM achievement.achievement WHERE id = ${a.achievementId}`,
    );
    expect(row[0]?.qualifying_value).toEqual({
      metricId: 'score',
      value: '300',
      unit: 'pins',
      precision: 0,
    });
    expect((await persist(threshold({ rv: 'pg2', value: '299' }))).achievements).toEqual([]);
  });

  it('personal best (lower is better): the comparison-set hash is stored for reproducibility', async () => {
    const snapshot = personalBestFixture({
      kind: 'RUNNING',
      value: '1180000',
      priors: [{ value: '1200000', minute: 10 }],
      disciplineVersionId: env.dv.running,
      ruleSpec: referencePersonalBestRule(env.dv.running, {
        key: 'elapsedTimeMs',
        markMetricId: 'elapsed_time_ms',
      }),
      ruleIdentity: pbRule,
    });
    const a = await one(snapshot);
    const row = await q(
      sql<{
        comparison_set_hash: string | null;
        scope_type: string;
      }>`SELECT comparison_set_hash, scope_type FROM achievement.achievement WHERE id = ${a.achievementId}`,
    );
    expect(row[0]?.comparison_set_hash).toMatch(/^sha256:/);
    expect(row[0]?.scope_type).toBe('CAREER');
  });
});

describe('integrity and immutability of fixture-lane rows', () => {
  it('append-only: UPDATE / DELETE of Achievement facts is refused even in the overlay DB', async () => {
    const a = await one(title({ rv: 'immutable' }));
    await expect(
      sql`UPDATE achievement.achievement SET holder_id = ${FX.teamB} WHERE id = ${a.achievementId}`.execute(
        env.owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(
      sql`DELETE FROM achievement.member_credit WHERE achievement_id = ${a.achievementId}`.execute(
        env.owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
  });

  it('forged candidates never validate: holder substitution, credit inflation, qualifyingValue forgery', () => {
    const sealed = sealDerivationSnapshot(title({ rv: 'forge' }));
    const d = deriveAchievements(sealed.snapshot);
    const entry = d.outcome.candidates?.[0];
    if (entry === undefined) throw new Error('none');
    const forged = [
      {
        ...entry,
        candidate: {
          ...entry.candidate,
          holder: { holderType: 'TEAM' as const, holderId: FX.teamB },
        },
      },
      {
        ...entry,
        candidate: {
          ...entry.candidate,
          memberCredits: [
            ...(entry.candidate.memberCredits ?? []),
            { athleteId: FX.unusedRosterAthlete, creditRole: 'LINEUP_MEMBER' as const },
          ],
        },
      },
      {
        ...entry,
        candidate: {
          ...entry.candidate,
          qualifyingValue: { metricId: 'score', value: '300', unit: 'pins', precision: 0 },
        },
      },
    ];
    for (const f of forged)
      expect(() => validateCandidate(sealed, d, f)).toThrow(/ACHIEVEMENT_INTEGRITY_FAILURE/);
  });

  it('read models rebuild through the maintenance login to identical output', async () => {
    const before = await snapshotAchievementReadModels(env.api);
    await rebuildAchievementReadModels(env.maintenance);
    expect(await snapshotAchievementReadModels(env.api)).toEqual(before);
  });
});

describe('BRT-08R · verification staleness propagates to current support without a new run', () => {
  const verification = (run: string, over: Record<string, unknown> = {}) => ({
    state: 'CURRENT' as const,
    runId: fixtureId(`run:${run}`),
    snapshotHash: fixtureHash(`verification-snapshot:${run}`),
    outcomeHash: fixtureHash(`verification-outcome:${run}`),
    level: 'V2' as const,
    ...over,
  });
  // The (fixture) current verification input of each basis version, as BRT-07 would report it now.
  const current = new Map<string, ReturnType<typeof verification>>();
  const source =
    (rv: string, pinned: string): SupportFactSource =>
    async (_ctx, achievementId) => {
      const v = current.get(rv);
      return v === undefined
        ? undefined
        : support(achievementId, rv, pinned, { basis: { verification: v } });
    };
  const sweep = (rv: string, pinned: string) =>
    sweepSupport(env.api, source(rv, pinned), {
      provenance: 'REFERENCE_FIXTURE',
      resultVersionIds: [fixtureId(`result-version:${rv}`)],
    });

  it('STALE pinned run (key compromise, no replacement run): never presented as currently supported; history byte-identical; recovery semantics', async () => {
    const a = await one(title({ rv: 'stale1' }));
    const row = async () =>
      (
        await q(
          sql<{
            candidate_hash: string;
            candidate: unknown;
            recorded_at: Date;
          }>`SELECT candidate_hash, candidate, recorded_at FROM achievement.achievement WHERE id = ${a.achievementId}`,
        )
      )[0];
    const before = await row();
    current.set('stale1', verification('stale1:run1', { state: 'STALE' }));
    // read-time live view: not ACTIVE even before any re-assessment is recorded
    expect(
      (await liveSupport(env.api, a.achievementId, source('stale1', 'stale1:run1')))?.status,
    ).toBe('SUSPENDED');
    // event-driven sweep records it; replay is idempotent
    expect(
      (await sweep('stale1', 'stale1:run1')).find((x) => x.achievementId === a.achievementId),
    ).toMatchObject({ status: 'SUSPENDED', changed: true });
    expect(
      (await sweep('stale1', 'stale1:run1')).find((x) => x.achievementId === a.achievementId),
    ).toMatchObject({ status: 'SUSPENDED', changed: false });
    await rebuildAchievementReadModels(env.maintenance);
    expect(await status(a.achievementId)).toMatchObject({
      status: 'SUSPENDED',
      reasons: ['VERIFICATION_STALE'],
    });
    expect(await row()).toEqual(before);
    // the SAME run becomes CURRENT again → ACTIVE (a new entry; nothing rewritten)
    current.set('stale1', verification('stale1:run1'));
    expect(
      (await sweep('stale1', 'stale1:run1')).find((x) => x.achievementId === a.achievementId)
        ?.status,
    ).toBe('ACTIVE');
    // a NEW CURRENT V2 run: the old pin is no longer current until re-derivation supersedes it
    current.set('stale1', verification('stale1:run2'));
    expect(
      (await sweep('stale1', 'stale1:run1')).find((x) => x.achievementId === a.achievementId)
        ?.status,
    ).toBe('SUSPENDED');
    const b = await one(title({ rv: 'stale1', run: 'stale1:run2' }));
    expect(b.supersedes).toEqual([a.achievementId]);
    expect((await status(a.achievementId))?.status).toBe('SUPERSEDED');
    expect((await status(b.achievementId))?.status).toBe('ACTIVE');
    expect(await row()).toEqual(before);
  });

  it('new CURRENT level V1 (e.g. after compromise re-evaluation): stays unsupported; no V2 Achievement is issued', async () => {
    const c = await one(title({ rv: 'stale2' }));
    current.set('stale2', verification('stale2:run3', { level: 'V1' }));
    expect(
      (await sweep('stale2', 'stale2:run1')).find((x) => x.achievementId === c.achievementId)
        ?.status,
    ).toBe('SUSPENDED');
    expect(
      (await persist(title({ rv: 'stale2', run: 'stale2:run3', level: 'V1' }))).achievements,
    ).toEqual([]);
    expect((await status(c.achievementId))?.status).toBe('SUSPENDED');
  });

  it('a REFERENCE_FIXTURE source can never assess a CANONICAL Achievement (provenance-bound status entries)', async () => {
    // (no canonical Achievement exists in the overlay DB; the DB rule BR123 is proven directly)
    const a = await one(title({ rv: 'prov' }));
    await expect(
      sql`INSERT INTO achievement.status_entry (id, achievement_id, status, support_facts_hash, assessment_provenance, recorded_at)
          VALUES (gen_random_uuid(), ${a.achievementId}, 'SUSPENDED', ${fixtureHash('x')}, 'CANONICAL_ASSEMBLY', platform.tx_time_ms())`.execute(
        env.owner,
      ),
    ).rejects.toMatchObject({ code: 'BR123' });
  });
});

describe('BRT-08R · evidenceCommitment and governingAuthority are pinned immutable content', () => {
  it('persisted evidence commitment and governing recognition equal the candidate; an authority change cannot rewrite them', async () => {
    const a = await one(title({ rv: 'gov1', recognition: { level: 'PLATFORM' } }));
    const r = (
      await q(sql<{
        evidence_commitment: string;
        governing_recognition_level: string;
        candidate: { evidenceCommitment: string };
      }>`
      SELECT evidence_commitment, governing_recognition_level, candidate FROM achievement.achievement WHERE id = ${a.achievementId}`)
    )[0];
    expect(r?.evidence_commitment).toBe(r?.candidate.evidenceCommitment);
    expect(r?.governing_recognition_level).toBe('PLATFORM');
    const b = (
      await q(
        sql<{
          evidence_bundle_hash: string;
        }>`SELECT evidence_bundle_hash FROM achievement.basis_item WHERE achievement_id = ${a.achievementId}`,
      )
    )[0];
    expect(b?.evidence_bundle_hash).toBe(fixtureHash('evidence-bundle:gov1:run1'));
    // Same pinned run, but a different (later) recognition claimed: the same logical Achievement with
    // different content is refused — the stored basis is never rewritten.
    await expect(
      persist(title({ rv: 'gov1', recognition: { level: 'NATIONAL' } })),
    ).rejects.toMatchObject({ code: 'ACHIEVEMENT_INTEGRITY_FAILURE' });
    expect(
      (
        await q(
          sql<{
            l: string;
          }>`SELECT governing_recognition_level AS l FROM achievement.achievement WHERE id = ${a.achievementId}`,
        )
      )[0]?.l,
    ).toBe('PLATFORM');
    const card = (
      await q(
        sql<
          Record<string, unknown>
        >`SELECT * FROM achievement_read.achievement_card WHERE achievement_id = ${a.achievementId}`,
      )
    )[0];
    expect(JSON.stringify(card)).not.toContain(fixtureId('anchor:PLATFORM')); // public projection: level only
  });
});

describe('BRT-08R-F · AC-4 regional recognition scope is pinned, enforced and hash-committed', () => {
  const nationalCr = {
    ...referenceTitleRule(''),
    displayName: 'Champion',
    requirements: {
      minimumVerificationLevel: 'V3' as const,
      minimumResultStatus: 'FINAL' as const,
    },
  };
  const scope = (region: string) => ({
    recognitionLevel: ['NATIONAL' as const],
    sport: ['padel'],
    region: [region],
  });
  let rule: FixtureRuleIdentity;
  let spec: ReturnType<typeof referenceTitleRule>;
  beforeAll(async () => {
    spec = {
      ...nationalCr,
      disciplineVersionId: env.dv.padel,
      criterion: {
        ...referenceTitleRule(env.dv.padel).criterion,
        recognitionClaim: { level: 'NATIONAL', region: ['CR'] },
      },
    };
    rule = await publishAchievementRule(env.rules, env.operatorAccountId, spec);
  });
  const national = (rv: string, region: string) =>
    padelTitleFixture({
      rv,
      level: 'V3',
      sport: 'padel',
      disciplineVersionId: env.dv.padel,
      ruleSpec: spec,
      ruleIdentity: rule,
      recognition: { level: 'NATIONAL', source: 'SANCTION', scope: scope(region) },
    });

  it('NATIONAL(CR) persists; a PE-scoped authority on the same basis is refused; the stored row never changes', async () => {
    const a = await one(national('acf1', 'CR'));
    const before = (
      await q(
        sql<
          Record<string, unknown>
        >`SELECT * FROM achievement.achievement WHERE id = ${a.achievementId}`,
      )
    )[0];
    const stored = before?.candidate as {
      governingAuthority: { recognitionScope: { region: string[] }; anchorFactHash: string };
    };
    expect(stored.governingAuthority.recognitionScope.region).toEqual(['CR']);
    expect(before?.governing_anchor_fact_hash).toBe(stored.governingAuthority.anchorFactHash);

    // Same basis, but the pinned governing authority is NATIONAL(PE): the engine blocks, nothing persists.
    const pe = await persist(national('acf1', 'PE'));
    expect(pe.achievements).toEqual([]);
    expect(pe.blockedBy).toContain('RECOGNITION_REGION_NOT_COVERED');
    const after = (
      await q(
        sql<
          Record<string, unknown>
        >`SELECT * FROM achievement.achievement WHERE id = ${a.achievementId}`,
      )
    )[0];
    expect(after).toEqual(before);

    // A forged candidate carrying the PE scope never validates against the CR snapshot.
    const sealed = sealDerivationSnapshot(national('acf1', 'CR'));
    const d = deriveAchievements(sealed.snapshot);
    const entry = d.outcome.candidates?.[0];
    const g = entry?.candidate.governingAuthority;
    if (entry === undefined || g === undefined) throw new Error('none');
    expect(() =>
      validateCandidate(sealed, d, {
        ...entry,
        candidate: {
          ...entry.candidate,
          governingAuthority: { ...g, recognitionScope: scope('PE') },
        },
      }),
    ).toThrow(/ACHIEVEMENT_INTEGRITY_FAILURE/);
    // CR → PE changes the snapshot hash (the scope is part of the immutable commitment).
    expect(sealDerivationSnapshot(national('acf1', 'PE')).snapshotHash).not.toBe(
      sealed.snapshotHash,
    );
  });

  it('public card / DTO: level, region and sport only — no anchor id, fact hash, grant or chain', async () => {
    const a = await one(national('acf2', 'CR'));
    const card = (
      await q(
        sql<
          Record<string, unknown>
        >`SELECT * FROM achievement_read.achievement_card WHERE achievement_id = ${a.achievementId}`,
      )
    )[0];
    expect(card?.governing_recognition_region).toEqual(['CR']);
    expect(card?.governing_recognition_sport).toEqual(['padel']);
    // fixture rows are never served by the public reader; the DTO mapping it uses is applied to the card
    const pub = publicGoverningRecognition(
      card as Parameters<typeof publicGoverningRecognition>[0],
    );
    expect(pub.governingRecognition).toEqual({
      level: 'NATIONAL',
      region: ['CR'],
      sport: ['padel'],
      statement: 'Backed by an authority recognized at NATIONAL level (region CR; sport padel).',
    });
    const text = JSON.stringify({ card, pub });
    expect(text).not.toContain(fixtureId('anchor:NATIONAL'));
    const raw = (
      await q(
        sql<{
          f: string;
        }>`SELECT governing_anchor_fact_hash AS f FROM achievement.achievement WHERE id = ${a.achievementId}`,
      )
    )[0];
    expect(text).not.toContain(String(raw?.f));
    expect(text).not.toMatch(/anchorId|anchorFactHash|grantId|grantChain/);
  });
});
