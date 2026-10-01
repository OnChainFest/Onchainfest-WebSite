import { referenceRecordSetRule, type SupportFacts } from '@br/achievements';
import type { FixtureRuleIdentity } from '@br/achievements/fixtures';
import {
  authorityWorld,
  categorySpec,
  recordSnapshot,
  rfxId,
  type AuthorityWorldOptions,
  type CategoryFixtureOptions,
  type PerformanceFixture,
  type SnapshotFixtureOptions,
} from '@br/records/fixtures';
import type { RecordCategorySpec, RecordEvaluationSnapshot } from '@br/records';
import { publishAchievementRule } from '@br/testkit/achievements';
import {
  createRecordFixtureEnvironment,
  futureInstant,
  plusMinutes,
  publishRecordCategory,
  recordSetSnapshotFor,
  RECORD_FIXTURE_ENVIRONMENT_BANNER,
  type RecordFixtureEnvironment,
} from '@br/testkit/records';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistDerivation, recordSupportAssessment } from './achievement-lanes';
import {
  persistRecordEvaluation,
  recordMarkSupportAssessment,
  standingMarksAt,
} from './record-lanes';
import { applicableCategoryVersions } from './record-loader';
import { rebuildRecordReadModels, snapshotRecordReadModels } from './record-projection';
import { recordDependencyIndex } from './record-store';
import { inTransaction, ModuleRole } from './tx';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *  REFERENCE FIXTURE PERSISTENCE ENVIRONMENT — NOT CANONICAL SPORTING TRUTH (BRT-09)
 *  Throwaway databases (br_recfx_<hex>), destroyed after the suite. The overlays relax ONLY the
 *  record / achievement provenance CHECKs; no upstream canonical table (results, verification,
 *  attestation, authority, identity) receives a synthetic fact. These tests prove BRT-09's OWN
 *  persistence mechanics (marks, ratification, replay, RECORD_SET linkage, projections).
 * ════════════════════════════════════════════════════════════════════════════════════════════
 */
let env: RecordFixtureEnvironment;
let recordSetRule: FixtureRuleIdentity;
let seq = 0;

beforeAll(async () => {
  env = await createRecordFixtureEnvironment({ overlay: true });
  recordSetRule = await publishAchievementRule(
    env.rules,
    env.operatorAccountId,
    referenceRecordSetRule(env.dv.running.id),
  );
}, 240_000);
afterAll(async () => {
  await env?.destroy();
});

interface Cat {
  readonly spec: RecordCategorySpec;
  readonly category: RecordEvaluationSnapshot['category'];
}

async function newCategory(o: CategoryFixtureOptions = {}): Promise<Cat> {
  const eff = futureInstant(30);
  const spec = categorySpec({
    scopeType: 'PLATFORM',
    ...o,
    disciplineVersionId: env.dv.running.id,
    sportCode: env.dv.running.sport,
    effectiveFrom: eff,
  });
  const c = await publishRecordCategory(env.categories, env.operatorAccountId, spec);
  return {
    spec,
    category: {
      categoryId: c.categoryId,
      code: c.code,
      categoryVersionId: c.categoryVersionId,
      version: c.version,
      specHash: c.specHash,
      spec,
      lifecycle: 'PUBLISHED',
    },
  };
}

const at = (cat: Cat, minutes: number) => plusMinutes(cat.spec.effectiveFrom, minutes);

async function snap(
  cat: Cat,
  p: PerformanceFixture,
  extra: Partial<SnapshotFixtureOptions> = {},
  exclude?: string,
): Promise<RecordEvaluationSnapshot> {
  const occurredAt = p.occurredAt ?? at(cat, p.minute);
  const currentMarks = await standingMarksAt(env.api, {
    categoryId: cat.category.categoryId,
    tiePolicy: cat.spec.tiePolicy,
    comparator: 'LOWER_IS_BETTER',
    at: occurredAt,
    provenance: 'REFERENCE_FIXTURE',
    ...(exclude === undefined ? {} : { excludeMarkId: exclude }),
  });
  return recordSnapshot({
    category: cat.category,
    performance: { ...p, occurredAt },
    discipline: { sport: env.dv.running.sport, discipline: env.dv.running.discipline },
    currentMarks,
    ...extra,
  });
}

async function establish(
  cat: Cat,
  p: PerformanceFixture,
  extra: Partial<SnapshotFixtureOptions> = {},
) {
  return persistRecordEvaluation(env.api, { snapshot: await snap(cat, p, extra) });
}

async function markHash(id: string) {
  const { rows } = await sql<{ mark_hash: string }>`
    SELECT mark_hash FROM record.record_mark WHERE id = ${id}`.execute(env.owner);
  return rows[0]?.mark_hash as string;
}

async function ratifySnapshot(
  cat: Cat,
  p: PerformanceFixture,
  recordMarkId: string,
  world: AuthorityWorldOptions = {},
  extra: Partial<SnapshotFixtureOptions> = {},
) {
  seq += 1;
  return snap(
    cat,
    p,
    {
      pending: { recordMarkId, markHash: await markHash(recordMarkId) },
      world: authorityWorld(cat.spec, world, `w${cat.category.code}`),
      ...extra,
    },
    recordMarkId,
  );
}

async function establishAndRatify(cat: Cat, p: PerformanceFixture) {
  const e = await establish(cat, p);
  expect(e.state).toBe('QUALIFIES');
  const r = await persistRecordEvaluation(env.api, {
    snapshot: await ratifySnapshot(cat, p, e.recordMarkId as string),
  });
  expect(r.state).toBe('QUALIFIES');
  return e.recordMarkId as string;
}

async function status(id: string) {
  const { rows } = await sql<{ status: string; effective_to: Date | null; reasons: string[] }>`
    SELECT status, effective_to, reasons FROM record.mark_status_entry WHERE record_mark_id = ${id}
    ORDER BY seq DESC LIMIT 1`.execute(env.owner);
  return rows[0];
}

async function current(cat: Cat) {
  const { rows } = await sql<{ record_mark_id: string }>`
    SELECT record_mark_id FROM record_read.mark_card WHERE category_id = ${cat.category.categoryId} AND is_current
    ORDER BY record_mark_id`.execute(env.owner);
  return rows.map((r) => r.record_mark_id);
}

async function hallOfFame(cat: Cat) {
  const { rows } = await sql<{ record_mark_id: string; holding: string }>`
    SELECT record_mark_id, holding FROM record_read.hall_of_fame_entry WHERE category_id = ${cat.category.categoryId}
    ORDER BY sort_key`.execute(env.owner);
  return rows;
}

const rescindFacts = (recordMarkId: string) =>
  ({
    provenance: 'REFERENCE_FIXTURE',
    recordMarkId,
    requiredLevel: 'V3',
    basisStatus: 'REVOKED',
  }) as const;

describe(RECORD_FIXTURE_ENVIRONMENT_BANNER.join(' · '), () => {
  it('a qualifying performance becomes ONE pending mark (idempotent; not in the Hall of Fame)', async () => {
    const cat = await newCategory();
    const p = { rv: 'pend-a', athlete: 'pa', value: '11000', minute: 1 };
    const a = await establish(cat, p);
    const b = await establish(cat, p);
    expect(a.state).toBe('QUALIFIES');
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.recordMarkId).toBe(a.recordMarkId);
    expect((await status(a.recordMarkId as string))?.status).toBe('PENDING_RATIFICATION');
    expect(await current(cat)).toEqual([]);
    expect(await hallOfFame(cat)).toEqual([]);
  });

  it('20 identical concurrent candidate writes ⇒ 1 logical mark, no raw uniqueness error', async () => {
    const cat = await newCategory();
    const s = await snap(cat, { rv: 'conc-a', athlete: 'ca', value: '11000', minute: 1 });
    const out = await Promise.all(
      Array.from({ length: 20 }, () => persistRecordEvaluation(env.api, { snapshot: s })),
    );
    expect(new Set(out.map((r) => r.recordMarkId)).size).toBe(1);
    expect(out.filter((r) => r.created)).toHaveLength(1);
  });

  it('ratification ⇒ RATIFIED + current + Hall of Fame; 20 identical ratifications ⇒ one transition', async () => {
    const cat = await newCategory();
    const p = { rv: 'rat-a', athlete: 'ra', value: '11000', minute: 1 };
    const e = await establish(cat, p);
    const s = await ratifySnapshot(cat, p, e.recordMarkId as string);
    const out = await Promise.all(
      Array.from({ length: 20 }, () => persistRecordEvaluation(env.api, { snapshot: s })),
    );
    expect(out.every((r) => r.state === 'QUALIFIES')).toBe(true);
    expect(out.filter((r) => r.created)).toHaveLength(1);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM record.mark_status_entry WHERE record_mark_id = ${e.recordMarkId as string}
        AND ratification_ref IS NOT NULL`.execute(env.owner);
    expect(rows[0]?.n).toBe(1);
    expect(await current(cat)).toEqual([e.recordMarkId]);
    expect(await hallOfFame(cat)).toEqual([{ record_mark_id: e.recordMarkId, holding: 'CURRENT' }]);
  });

  it('RECORD_SET: only after ratification, exactly once, append-only link (mark row never mutated)', async () => {
    const cat = await newCategory();
    const p = { rv: 'rs-a', athlete: 'rsa', value: '10990', minute: 1 };
    const e = await establish(cat, p);
    const id = e.recordMarkId as string;
    const pendingSnap = await recordSetSnapshotFor(env.owner, {
      recordMarkId: id,
      recordSnapshot: await snap(cat, p),
      ruleSpec: referenceRecordSetRule(env.dv.running.id),
      ruleIdentity: recordSetRule,
    });
    const pending = await persistDerivation(env.api, { snapshot: pendingSnap });
    expect(pending.state).toBe('BLOCKED');
    expect(pending.blockedBy).toContain('RECORD_MARK_UNAVAILABLE');
    expect(pending.achievements).toHaveLength(0);
    const before = (
      await sql<{
        candidate: unknown;
      }>`SELECT candidate FROM record.record_mark WHERE id = ${id}`.execute(env.owner)
    ).rows[0];
    await persistRecordEvaluation(env.api, { snapshot: await ratifySnapshot(cat, p, id) });
    const rsSnap = await recordSetSnapshotFor(env.owner, {
      recordMarkId: id,
      recordSnapshot: await snap(cat, p),
      ruleSpec: referenceRecordSetRule(env.dv.running.id),
      ruleIdentity: recordSetRule,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => persistDerivation(env.api, { snapshot: rsSnap })),
    );
    const ids = new Set(results.flatMap((r) => r.achievements.map((a) => a.achievementId)));
    expect(ids.size).toBe(1);
    const { rows: links } = await sql<{ achievement_id: string }>`
      SELECT achievement_id FROM achievement.record_basis WHERE record_mark_id = ${id}`.execute(
      env.owner,
    );
    expect(links).toHaveLength(1);
    const after = (
      await sql<{
        candidate: unknown;
      }>`SELECT candidate FROM record.record_mark WHERE id = ${id}`.execute(env.owner)
    ).rows[0];
    expect(after).toEqual(before);
    const dep = await inTransaction(env.api, ModuleRole.records, (ctx) =>
      recordDependencyIndex(ctx, { recordMarkId: id }),
    );
    expect(
      dep.some(
        (d) => d.dependencyType === 'RATIFICATION' && d.recordSetAchievementId === [...ids][0],
      ),
    ).toBe(true);
    // Rescinding the mark revokes the RECORD_SET (via the Achievement's own support assessment).
    await recordMarkSupportAssessment(env.api, rescindFacts(id));
    const achievementId = [...ids][0] as string;
    const revoked = await recordSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      achievementId,
      requiredLevel: 'V3',
      basis: [
        {
          resultVersionId: rsSnap.resultVersion.resultVersionId,
          pinnedRunId: rsSnap.verification.runId as string,
          status: 'FINAL',
          verification: rsSnap.verification,
        },
      ],
      recordMarkStatus: 'RESCINDED',
    } satisfies SupportFacts);
    expect(revoked.status).toBe('REVOKED');
  });

  it('§53: a ratified correction replaces the original append-only; the correction fact alone changes nothing', async () => {
    const cat = await newCategory();
    const rsOf = async (recordMarkId: string, p: PerformanceFixture) =>
      recordSetSnapshotFor(env.owner, {
        recordMarkId,
        recordSnapshot: await snap(cat, p),
        ruleSpec: referenceRecordSetRule(env.dv.running.id),
        ruleIdentity: recordSetRule,
      });
    // A: original result ⇒ ratified, current mark ⇒ one RECORD_SET.
    const po = { rv: 'cor-a', athlete: 'cora', value: '11000', minute: 1 };
    const a = await establishAndRatify(cat, po);
    const rsA = await rsOf(a, po);
    const setA = await persistDerivation(env.api, { snapshot: rsA });
    expect(setA.achievements).toHaveLength(1);
    const achA = setA.achievements[0]?.achievementId as string;
    const rowA = async () =>
      (await sql`SELECT * FROM record.record_mark WHERE id = ${a}`.execute(env.owner)).rows;
    const statusesOf = async (id: string) =>
      (
        await sql<{ seq: string; status: string; reasons: string[]; effective_to: Date | null }>`
          SELECT seq, status, reasons, effective_to FROM record.mark_status_entry WHERE record_mark_id = ${id}
          ORDER BY seq`.execute(env.owner)
      ).rows;
    const markA = await rowA();
    expect(markA[0]).toMatchObject({ result_version_id: rfxId('rv:cor-a') });
    const historyA = await statusesOf(a);
    expect(historyA.map((s) => s.status)).toEqual(['PENDING_RATIFICATION', 'RATIFIED']);
    expect(await current(cat)).toEqual([a]);

    // B: the corrected ResultVersion (upstream correction fact on the snapshot) ⇒ a NEW pending mark.
    const pc = { rv: 'cor-a2', athlete: 'cora', value: '10950', minute: 1, supersedes: 'cor-a' };
    const cs = await snap(cat, pc);
    expect(cs.performance.supersedesVersionId).toBe(rfxId('rv:cor-a'));
    const eb = await persistRecordEvaluation(env.api, { snapshot: cs });
    expect(eb.state).toBe('QUALIFIES');
    expect(eb.created).toBe(true);
    const b = eb.recordMarkId as string;
    expect(b).not.toBe(a);
    const correctsOf = async (id: string) =>
      (
        await sql<{ dependency_id: string }>`
          SELECT dependency_id FROM record.mark_dependency WHERE record_mark_id = ${id}
            AND dependency_type = 'CORRECTS_MARK'`.execute(env.owner)
      ).rows.map((r) => r.dependency_id);
    expect(await correctsOf(b)).toEqual([a]);
    expect(await correctsOf(a)).toEqual([]);

    // C: the upstream correction fact by itself never makes the replacement current.
    expect((await status(b))?.status).toBe('PENDING_RATIFICATION');
    expect(await current(cat)).toEqual([a]);
    expect(await statusesOf(a)).toEqual(historyA);
    expect(await hallOfFame(cat)).toEqual([{ record_mark_id: a, holding: 'CURRENT' }]);
    const awaiting = await recordMarkSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      recordMarkId: a,
      requiredLevel: 'V3',
      basisStatus: 'SUPERSEDED',
      supersededByVersionId: rfxId('rv:cor-a2'),
      successor: 'QUALIFIES',
    });
    expect(awaiting.assessment).toMatchObject({
      support: 'SUSPENDED',
      action: 'AWAIT_REPLACEMENT',
    });
    expect(awaiting.rescinded).toBe(false);
    expect(await current(cat)).toEqual([a]);
    expect(await statusesOf(a)).toEqual(historyA);
    // A replacement without the required verification / ratification cannot supersede.
    const lowLevel = await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(cat, { ...pc, level: 'V2' }, b),
    });
    expect(lowLevel.state).not.toBe('QUALIFIES');
    expect(lowLevel.blockedBy).toContain('VERIFICATION_LEVEL_BELOW_REQUIRED');
    const unratified = await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(cat, pc, b, {}, { ratification: null }),
    });
    expect(unratified.state).not.toBe('QUALIFIES');
    expect((await status(b))?.status).toBe('PENDING_RATIFICATION');
    expect(await current(cat)).toEqual([a]);
    expect(await statusesOf(a)).toEqual(historyA);
    // Before ratification no RECORD_SET exists for the replacement.
    const pendingSet = await persistDerivation(env.api, { snapshot: await rsOf(b, pc) });
    expect(pendingSet.achievements).toHaveLength(0);

    // D: valid ratification ⇒ B current, A SUPERSEDED (CORRECTION), A's history appended only.
    const ratB = await ratifySnapshot(cat, pc, b);
    const rb = await persistRecordEvaluation(env.api, { snapshot: ratB });
    expect(rb.state).toBe('QUALIFIES');
    expect(rb.created).toBe(true);
    expect(await current(cat)).toEqual([b]);
    expect(await rowA()).toEqual(markA);
    const afterA = await statusesOf(a);
    expect(afterA.slice(0, historyA.length)).toEqual(historyA);
    expect(afterA.map((s) => s.status)).toEqual(['PENDING_RATIFICATION', 'RATIFIED', 'SUPERSEDED']);
    expect(afterA[2]?.reasons).toContain('CORRECTED_BY_NEW_MARK');
    const { rows: links } = await sql<{ superseding_mark_id: string; kind: string }>`
      SELECT superseding_mark_id, kind FROM record.mark_supersession WHERE superseded_mark_id = ${a}`.execute(
      env.owner,
    );
    expect(links).toContainEqual({ superseding_mark_id: b, kind: 'CORRECTION' });
    expect(await correctsOf(b)).toEqual([a]);
    const { rows: cardA } = await sql<{ status: string; is_current: boolean }>`
      SELECT status, is_current FROM record_read.mark_card WHERE record_mark_id = ${a}`.execute(
      env.owner,
    );
    expect(cardA[0]).toEqual({ status: 'SUPERSEDED', is_current: false });

    // E: B gets its own RECORD_SET, which replaces A's through BRT-08's append-only correction path.
    const rsB = await rsOf(b, pc);
    expect(rsB.resultVersion.supersedesVersionId).toBe(rfxId('rv:cor-a'));
    const setB = await persistDerivation(env.api, { snapshot: rsB });
    expect(setB.achievements).toHaveLength(1);
    const achB = setB.achievements[0]?.achievementId as string;
    expect(achB).not.toBe(achA);
    expect(setB.achievements[0]?.supersedes).toEqual([achA]);
    const basisOf = async (id: string) =>
      (
        await sql<{ achievement_id: string }>`
          SELECT achievement_id FROM achievement.record_basis WHERE record_mark_id = ${id}`.execute(
          env.owner,
        )
      ).rows.map((r) => r.achievement_id);
    expect(await basisOf(a)).toEqual([achA]);
    expect(await basisOf(b)).toEqual([achB]);
    const { rows: achStatus } = await sql<{ status: string }>`
      SELECT status FROM achievement.v_achievement_status WHERE achievement_id = ${achA}`.execute(
      env.owner,
    );
    expect(achStatus[0]?.status).toBe('SUPERSEDED');
    // Replaying A's original derivation never creates a duplicate RECORD_SET for the original.
    const replayA = await persistDerivation(env.api, { snapshot: rsA });
    expect(replayA.achievements.every((x) => x.achievementId === achA && !x.created)).toBe(true);
    expect(await basisOf(a)).toEqual([achA]);

    // F: the Hall of Fame shows the replacement as the record; history remains available.
    const hof = await hallOfFame(cat);
    expect(hof).toContainEqual({ record_mark_id: b, holding: 'CURRENT' });
    expect(hof.filter((h) => h.holding === 'CURRENT')).toEqual([
      { record_mark_id: b, holding: 'CURRENT' },
    ]);

    // G: replaying the correction / ratification / RECORD_SET path duplicates nothing.
    const counts = async () =>
      (
        await sql<Record<string, number>>`
          SELECT
            (SELECT count(*)::int FROM record.record_mark WHERE category_id = ${cat.category.categoryId}) AS marks,
            (SELECT count(*)::int FROM record.mark_status_entry WHERE record_mark_id IN (${a}, ${b})) AS statuses,
            (SELECT count(*)::int FROM record.mark_dependency WHERE record_mark_id IN (${a}, ${b})) AS dependencies,
            (SELECT count(*)::int FROM record.mark_supersession WHERE superseded_mark_id IN (${a}, ${b})) AS supersessions,
            (SELECT count(*)::int FROM achievement.record_basis WHERE record_mark_id IN (${a}, ${b})) AS record_sets`.execute(
          env.owner,
        )
      ).rows[0];
    const before = await counts();
    const again = await persistRecordEvaluation(env.api, { snapshot: cs });
    expect(again).toMatchObject({ recordMarkId: b, created: false });
    expect(await persistRecordEvaluation(env.api, { snapshot: ratB })).toMatchObject({
      recordMarkId: b,
      created: false,
    });
    const setB2 = await persistDerivation(env.api, { snapshot: rsB });
    expect(setB2.achievements.map((x) => [x.achievementId, x.created])).toEqual([[achB, false]]);
    expect(await counts()).toEqual(before);
    expect(await current(cat)).toEqual([b]);

    // Rebuild equals the incremental projection.
    const projected = await snapshotRecordReadModels(env.api);
    await rebuildRecordReadModels(env.maintenance);
    expect(await snapshotRecordReadModels(env.api)).toEqual(projected);
    expect(await hallOfFame(cat)).toEqual(hof);
  });

  it('RC-2: a better PENDING mark never supersedes; after ratification the prior mark is SUPERSEDED at its effectiveFrom', async () => {
    const cat = await newCategory();
    const a = await establishAndRatify(cat, {
      rv: 'sup-a',
      athlete: 'sa',
      value: '11000',
      minute: 1,
    });
    const pb = { rv: 'sup-b', athlete: 'sb', value: '10900', minute: 5 };
    const b = await establish(cat, pb);
    expect(await current(cat)).toEqual([a]);
    await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(cat, pb, b.recordMarkId as string),
    });
    expect(await current(cat)).toEqual([b.recordMarkId]);
    const sa = await status(a);
    expect(sa?.status).toBe('SUPERSEDED');
    expect(sa?.effective_to?.toISOString()).toBe(at(cat, 5));
    expect(await hallOfFame(cat)).toEqual([
      { record_mark_id: a, holding: 'FORMER' },
      { record_mark_id: b.recordMarkId, holding: 'CURRENT' },
    ]);
    // 10.95 is not better than 10.90 (lower is better).
    const worse = await establish(cat, { rv: 'sup-c', athlete: 'sc', value: '10950', minute: 9 });
    expect(worse.state).toBe('DOES_NOT_QUALIFY');
  });

  it('SHARED: equal marks co-hold (also when ratified concurrently); a better mark supersedes both', async () => {
    const cat = await newCategory({ tiePolicy: 'SHARED' });
    const pa = { rv: 'sh-a', athlete: 'sha', value: '10900', minute: 1 };
    const pb = { rv: 'sh-b', athlete: 'shb', value: '10900', minute: 2 };
    const ea = await establish(cat, pa);
    const eb = await establish(cat, pb);
    const [ra, rb] = await Promise.all([
      ratifySnapshot(cat, pa, ea.recordMarkId as string),
      ratifySnapshot(cat, pb, eb.recordMarkId as string),
    ]);
    await Promise.all([
      persistRecordEvaluation(env.api, { snapshot: ra }),
      persistRecordEvaluation(env.api, { snapshot: rb }),
    ]);
    expect(await current(cat)).toEqual([ea.recordMarkId, eb.recordMarkId].sort());
    const c = await establishAndRatify(cat, {
      rv: 'sh-c',
      athlete: 'shc',
      value: '10800',
      minute: 3,
    });
    expect(await current(cat)).toEqual([c]);
    expect((await status(ea.recordMarkId as string))?.status).toBe('SUPERSEDED');
    expect((await status(eb.recordMarkId as string))?.status).toBe('SUPERSEDED');
  });

  it('FIRST_ACHIEVED: an equal later mark never becomes a record', async () => {
    const cat = await newCategory({ tiePolicy: 'FIRST_ACHIEVED' });
    const a = await establishAndRatify(cat, {
      rv: 'fa-a',
      athlete: 'faa',
      value: '10900',
      minute: 1,
    });
    const b = await establish(cat, { rv: 'fa-b', athlete: 'fab', value: '10900', minute: 2 });
    expect(b.state).toBe('DOES_NOT_QUALIFY');
    expect(b.blockedBy).toContain('EQUALS_CURRENT_RECORD_FIRST_ACHIEVED');
    expect(await current(cat)).toEqual([a]);
  });

  it('RC-3: rescind C ⇒ B restored; rescind B ⇒ A restored; history stays append-only', async () => {
    const cat = await newCategory();
    const a = await establishAndRatify(cat, {
      rv: 'rc-a',
      athlete: 'rca',
      value: '10000',
      minute: 1,
    });
    const b = await establishAndRatify(cat, {
      rv: 'rc-b',
      athlete: 'rcb',
      value: '9800',
      minute: 2,
    });
    const c = await establishAndRatify(cat, {
      rv: 'rc-c',
      athlete: 'rcc',
      value: '9700',
      minute: 3,
    });
    expect(await current(cat)).toEqual([c]);
    const r1 = await recordMarkSupportAssessment(env.api, rescindFacts(c));
    expect(r1.rescinded).toBe(true);
    expect(await current(cat)).toEqual([b]);
    expect((await status(b))?.reasons).toContain('RESTORED_BY_REPLAY');
    await recordMarkSupportAssessment(env.api, rescindFacts(b));
    expect(await current(cat)).toEqual([a]);
    // The closed effectiveTo of A stays in its history; restorations are new entries.
    const { rows } = await sql<{ status: string; effective_to: Date | null }>`
      SELECT status, effective_to FROM record.mark_status_entry WHERE record_mark_id = ${a} ORDER BY seq`.execute(
      env.owner,
    );
    expect(rows.map((r) => r.status)).toEqual([
      'PENDING_RATIFICATION',
      'RATIFIED',
      'SUPERSEDED',
      'RATIFIED',
    ]);
    expect(rows[2]?.effective_to?.toISOString()).toBe(at(cat, 2));
    // Rescinded marks stay in audit history but never in the Hall of Fame.
    const hof = await hallOfFame(cat);
    expect(hof.map((h) => h.record_mark_id)).not.toContain(c);
    expect(hof.map((h) => h.record_mark_id)).not.toContain(b);
    const { rows: cards } = await sql<{ status: string; record_label: string }>`
      SELECT status, record_label FROM record_read.mark_card WHERE record_mark_id = ${c}`.execute(
      env.owner,
    );
    expect(cards[0]?.status).toBe('RESCINDED');
    expect(cards[0]?.record_label).toMatch(/rescinded — not a record/);
    // Append-only even for the owner.
    await expect(
      sql`UPDATE record.mark_status_entry SET reasons = '{}' WHERE record_mark_id = ${a}`.execute(
        env.owner,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      sql`DELETE FROM record.record_mark WHERE id = ${a}`.execute(env.owner),
    ).rejects.toThrow(/append-only/);
  });

  it('intermediate history: A, B, C, D with B and D invalidated ⇒ C current (chronological replay)', async () => {
    const cat = await newCategory();
    const a = await establishAndRatify(cat, {
      rv: 'ih-a',
      athlete: 'iha',
      value: '10000',
      minute: 1,
    });
    const b = await establishAndRatify(cat, {
      rv: 'ih-b',
      athlete: 'ihb',
      value: '9900',
      minute: 2,
    });
    const c = await establishAndRatify(cat, {
      rv: 'ih-c',
      athlete: 'ihc',
      value: '9800',
      minute: 3,
    });
    const d = await establishAndRatify(cat, {
      rv: 'ih-d',
      athlete: 'ihd',
      value: '9700',
      minute: 4,
    });
    await recordMarkSupportAssessment(env.api, rescindFacts(b));
    expect(await current(cat)).toEqual([d]);
    await recordMarkSupportAssessment(env.api, rescindFacts(d));
    expect(await current(cat)).toEqual([c]);
    const sa = await status(a);
    expect(sa?.status).toBe('SUPERSEDED');
    expect(sa?.effective_to?.toISOString()).toBe(at(cat, 3));
  });

  it('temporary verification suspension never rescinds', async () => {
    const cat = await newCategory();
    const a = await establishAndRatify(cat, {
      rv: 'ts-a',
      athlete: 'tsa',
      value: '10000',
      minute: 1,
    });
    const r = await recordMarkSupportAssessment(env.api, {
      provenance: 'REFERENCE_FIXTURE',
      recordMarkId: a,
      requiredLevel: 'V3',
      basisStatus: 'FINAL',
      verification: { state: 'STALE' },
    });
    expect(r.assessment.support).toBe('SUSPENDED');
    expect(r.rescinded).toBe(false);
    expect(await current(cat)).toEqual([a]);
  });

  it('20 competing better-mark attempts ⇒ the deterministic best is current', async () => {
    const cat = await newCategory();
    const perfs = Array.from({ length: 20 }, (_, i) => ({
      rv: `comp-${i}`,
      athlete: `comp${i}`,
      value: String(11000 - i * 10),
      minute: 1 + i,
    }));
    const est = await Promise.all(perfs.map((p) => establish(cat, p)));
    expect(est.every((e) => e.state === 'QUALIFIES')).toBe(true);
    for (let i = 0; i < perfs.length; i++) {
      const p = perfs[i] as PerformanceFixture;
      await persistRecordEvaluation(env.api, {
        snapshot: await ratifySnapshot(cat, p, est[i]?.recordMarkId as string),
      });
    }
    expect(await current(cat)).toEqual([est[19]?.recordMarkId]);
  });

  it('V4 national: V3 claim; V3 at ratification stays pending; V4 + keeper ⇒ CANONICAL; NATIONAL(PE) cannot ratify CR', async () => {
    const cat = await newCategory({ scopeType: 'NATIONAL', region: ['CR'], canonicalKeeper: true });
    const p3 = { rv: 'v4-a', athlete: 'v4a', value: '9900', minute: 1, level: 'V3' as const };
    const e = await establish(cat, p3);
    expect(e.state).toBe('QUALIFIES');
    const id = e.recordMarkId as string;
    const stillV3 = await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(cat, p3, id, { ratifierIsKeeper: true }),
    });
    expect(stillV3.blockedBy).toContain('VERIFICATION_LEVEL_BELOW_REQUIRED');
    const p4 = { ...p3, level: 'V4' as const, v4CategoryIds: [cat.category.categoryId] };
    const pe = await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(cat, p4, id, {
        anchorRegion: ['PE'],
        grantRegion: ['PE'],
        ratifierIsKeeper: true,
      }),
    });
    expect(pe.state).toBe('PENDING_REQUIRED_FACTS');
    const ok = await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(cat, p4, id, { ratifierIsKeeper: true }),
    });
    expect(ok.markStatus).toBe('CANONICAL');
    expect((await status(id))?.status).toBe('CANONICAL');
  });

  it('the database refuses CANONICAL for PLATFORM and ratification without an exact mark hash', async () => {
    const cat = await newCategory();
    const e = await establish(cat, { rv: 'db-a', athlete: 'dba', value: '11000', minute: 1 });
    const id = e.recordMarkId as string;
    const attempt = (status: string, hash: string) =>
      sql`INSERT INTO record.mark_status_entry (id, record_mark_id, status, ratification, ratification_hash,
            ratification_provenance, ratification_ref, assessment_provenance, recorded_at)
          VALUES (${rfxId(`x${seq++}`)}, ${id}, ${status},
                  ${JSON.stringify({ recordMarkId: id, markHash: hash, subjectHash: hash, ref: rfxId('r'), provenance: 'REFERENCE_FIXTURE', standing: status })},
                  ${hash}, 'REFERENCE_FIXTURE', ${rfxId('r')}, 'REFERENCE_FIXTURE', platform.tx_time_ms())`.execute(
        env.owner,
      );
    await expect(attempt('RATIFIED', `sha256:${'0'.repeat(64)}`)).rejects.toThrow(
      /exact mark hash/,
    );
    await expect(attempt('CANONICAL', await markHash(id))).rejects.toThrow(/canonical keeper/);
  });

  it('dependency index answers ResultVersion / VerificationRun / category version queries', async () => {
    const cat = await newCategory();
    const p = { rv: 'dep-a', athlete: 'dpa', value: '11000', minute: 1 };
    const s = await snap(cat, p);
    const e = await persistRecordEvaluation(env.api, { snapshot: s });
    const q = (x: Parameters<typeof recordDependencyIndex>[1]) =>
      inTransaction(env.api, ModuleRole.records, (ctx) => recordDependencyIndex(ctx, x));
    expect(
      (await q({ resultVersionId: s.performance.resultVersionId })).map((d) => d.recordMarkId),
    ).toContain(e.recordMarkId);
    expect(
      (await q({ verificationRunId: s.verification.runId as string })).map((d) => d.recordMarkId),
    ).toContain(e.recordMarkId);
    expect(
      (await q({ categoryVersionId: cat.category.categoryVersionId })).map((d) => d.recordMarkId),
    ).toEqual([e.recordMarkId]);
  });

  it('read models (current records, history, Record Hall of Fame, Passport rows) rebuild identically', async () => {
    const before = await snapshotRecordReadModels(env.api);
    await rebuildRecordReadModels(env.maintenance);
    expect(await snapshotRecordReadModels(env.api)).toEqual(before);
  });

  it('§114 / §115: a V1 mark pins V1 forever; V2 governs later performances; retiring V1 rewrites nothing', async () => {
    const v1Cat = await newCategory();
    const v1 = v1Cat.category;
    const ma = await establishAndRatify(v1Cat, {
      rv: 'pin-a',
      athlete: 'pina',
      value: '11000',
      minute: 1,
    });
    // The mark pins the exact category / version / spec hash it was evaluated under.
    const { rows: pinned } = await sql<{
      category_id: string;
      category_version_id: string;
      category_spec_hash: string;
      candidate: { category: { categoryVersionId: string; version: number; specHash: string } };
    }>`
      SELECT category_id, category_version_id, category_spec_hash, candidate FROM record.record_mark WHERE id = ${ma}`.execute(
      env.owner,
    );
    expect(pinned[0]).toMatchObject({
      category_id: v1.categoryId,
      category_version_id: v1.categoryVersionId,
      category_spec_hash: v1.specHash,
      candidate: {
        category: { categoryVersionId: v1.categoryVersionId, version: 1, specHash: v1.specHash },
      },
    });
    const pinOf = async (id: string) =>
      (
        await sql<{ dependency_id: string; dependency_hash: string }>`
          SELECT dependency_id, dependency_hash FROM record.mark_dependency
          WHERE record_mark_id = ${id} AND dependency_type = 'CATEGORY_VERSION'`.execute(env.owner)
      ).rows;
    expect(await pinOf(ma)).toEqual([
      { dependency_id: v1.categoryVersionId, dependency_hash: v1.specHash },
    ]);
    const historyOf = async (id: string) => ({
      mark: (await sql`SELECT * FROM record.record_mark WHERE id = ${id}`.execute(env.owner)).rows,
      statuses: (
        await sql`SELECT * FROM record.mark_status_entry WHERE record_mark_id = ${id} ORDER BY seq`.execute(
          env.owner,
        )
      ).rows,
      dependencies: (
        await sql`SELECT * FROM record.mark_dependency WHERE record_mark_id = ${id}
          ORDER BY dependency_type, dependency_id`.execute(env.owner)
      ).rows,
    });
    const card = async (id: string) =>
      (
        await sql<{
          category_version_id: string;
          category_version: number;
          status: string;
          is_current: boolean;
          record_label: string;
        }>`
          SELECT category_version_id, category_version, status, is_current, record_label
          FROM record_read.mark_card WHERE record_mark_id = ${id}`.execute(env.owner)
      ).rows[0];
    const historyA = await historyOf(ma);
    const cardA = await card(ma);
    expect(cardA).toMatchObject({
      category_version_id: v1.categoryVersionId,
      category_version: 1,
      status: 'RATIFIED',
      is_current: true,
    });

    // V2: same universe, changed policy (raised verification floor, new display name).
    const v2Spec = categorySpec({
      scopeType: 'PLATFORM',
      displayName: '100 m time (revised)',
      minimumVerificationLevel: 'V4',
      disciplineVersionId: env.dv.running.id,
      sportCode: env.dv.running.sport,
      effectiveFrom: at(v1Cat, 10),
    });
    const v2Row = await publishRecordCategory(env.categories, env.operatorAccountId, v2Spec, {
      categoryId: v1.categoryId,
      code: v1.code,
    });
    expect(v2Row.version).toBe(2);
    expect(v2Row.specHash).not.toBe(v1.specHash);
    const v2Cat: Cat = {
      spec: v2Spec,
      category: { ...v1, ...v2Row, spec: v2Spec, lifecycle: 'PUBLISHED' },
    };

    // Selection by sporting time: V1 governs its period, V2 (highest PUBLISHED in force) later.
    const applicable = (minute: number) =>
      inTransaction(env.api, ModuleRole.records, (ctx) =>
        applicableCategoryVersions(ctx, {
          disciplineVersionId: env.dv.running.id,
          markMetricIds: [v1Cat.spec.universe.metric.markMetricId],
          occurredAt: new Date(at(v1Cat, minute)),
        }),
      ).then((vs) =>
        vs.filter((v) => v.categoryId === v1.categoryId).map((v) => v.categoryVersionId),
      );
    expect(await applicable(3)).toEqual([v1.categoryVersionId]);
    expect(await applicable(20)).toEqual([v2Row.categoryVersionId]);

    // A later (better) performance is evaluated under V2 and pins V2. V2's raised floor admits a V3
    // claim as PENDING only (BRT-01: V4 is required at ratification), so ratifying at V3 — exactly
    // what made A a record under V1 — is refused by V2's policy.
    const pb = { rv: 'pin-b', athlete: 'pinb', value: '10900', minute: 20, level: 'V3' as const };
    const eb = await establish(v2Cat, pb);
    expect(eb.state).toBe('QUALIFIES');
    const mb = eb.recordMarkId as string;
    expect(await pinOf(mb)).toEqual([
      { dependency_id: v2Row.categoryVersionId, dependency_hash: v2Row.specHash },
    ]);
    const atV3 = await persistRecordEvaluation(env.api, {
      snapshot: await ratifySnapshot(v2Cat, pb, mb),
    });
    expect(atV3.state).not.toBe('QUALIFIES');
    expect(atV3.blockedBy).toContain('VERIFICATION_LEVEL_BELOW_REQUIRED');
    expect((await status(mb))?.status).toBe('PENDING_RATIFICATION');
    expect(await current(v1Cat)).toEqual([ma]);

    // The V1 mark is NOT reinterpreted under V2's higher floor: same rows, still current.
    expect(await historyOf(ma)).toEqual(historyA);
    expect(await card(ma)).toEqual(cardA);
    expect(await current(v1Cat)).toEqual([ma]);

    // Retiring V1 does not rewrite, rescind or de-list the historical V1 mark.
    const hofBefore = await hallOfFame(v1Cat);
    await env.categories.changeVersionStatus({
      operatorAccountId: env.operatorAccountId,
      categoryVersionId: v1.categoryVersionId,
      status: 'RETIRED',
    });
    expect(await historyOf(ma)).toEqual(historyA);
    expect(await card(ma)).toEqual(cardA);
    expect(await current(v1Cat)).toEqual([ma]);
    expect(await hallOfFame(v1Cat)).toEqual(hofBefore);
    expect(hofBefore).toEqual([{ record_mark_id: ma, holding: 'CURRENT' }]);
    expect(await applicable(3)).toEqual([]);
    expect(await applicable(20)).toEqual([v2Row.categoryVersionId]);

    // A new candidate cannot use the retired version: refused by the engine when honest …
    const retiredCat: Cat = { ...v1Cat, category: { ...v1, lifecycle: 'RETIRED' } };
    const late = { rv: 'pin-d', athlete: 'pind', value: '10950', minute: 3 };
    const refused = await establish(retiredCat, late);
    expect(refused.state).toBe('INELIGIBLE');
    expect(refused.blockedBy).toContain('CATEGORY_VERSION_RETIRED');
    expect(refused.recordMarkId).toBeUndefined();
    // … and by the database when a snapshot claims the retired version is still PUBLISHED.
    await expect(establish(v1Cat, late)).rejects.toThrow(/PUBLISHED category version/);
    const { rows: marks } = await sql<{ id: string }>`
      SELECT id FROM record.record_mark WHERE category_id = ${v1.categoryId} ORDER BY id`.execute(
      env.owner,
    );
    expect(marks.map((m) => m.id)).toEqual([ma, mb].sort());

    // Deterministic read model; rebuild equals incremental projection.
    const before = await snapshotRecordReadModels(env.api);
    expect(await snapshotRecordReadModels(env.api)).toEqual(before);
    await rebuildRecordReadModels(env.maintenance);
    expect(await snapshotRecordReadModels(env.api)).toEqual(before);
    expect(await card(ma)).toEqual(cardA);
  });

  it('a HANDICAP value never enters a SCRATCH category (persisted evaluation is INELIGIBLE, no mark)', async () => {
    const cat = await newCategory({ population: { handicapMode: 'SCRATCH' } });
    const r = await establish(
      cat,
      { rv: 'hc-a', athlete: 'hca', value: '11000', minute: 1 },
      { population: { HANDICAP_MODE: 'HANDICAP' } },
    );
    expect(r.state).toBe('INELIGIBLE');
    expect(r.recordMarkId).toBeUndefined();
    const u = await establish(cat, { rv: 'hc-b', athlete: 'hcb', value: '11000', minute: 1 });
    expect(u.blockedBy).toContain('POPULATION_FACT_UNAVAILABLE');
  });
});

describe('normal schema containment (no overlay)', () => {
  it('refuses REFERENCE_FIXTURE marks — fixtures can never escape into a normal database', async () => {
    const plain = await createRecordFixtureEnvironment({ overlay: false });
    try {
      const eff = futureInstant(30);
      const spec = categorySpec({
        scopeType: 'PLATFORM',
        disciplineVersionId: plain.dv.running.id,
        sportCode: plain.dv.running.sport,
        effectiveFrom: eff,
      });
      const c = await publishRecordCategory(plain.categories, plain.operatorAccountId, spec);
      const s = recordSnapshot({
        category: { ...c, spec, lifecycle: 'PUBLISHED' },
        performance: { rv: 'x', value: '11000', minute: 0, occurredAt: plusMinutes(eff, 1) },
        discipline: { sport: plain.dv.running.sport, discipline: plain.dv.running.discipline },
      });
      await expect(persistRecordEvaluation(plain.api, { snapshot: s })).rejects.toThrow(
        /record_mark_canonical_provenance_only|check constraint/,
      );
    } finally {
      await plain.destroy();
    }
  }, 240_000);
});
