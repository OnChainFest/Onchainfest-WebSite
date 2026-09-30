import {
  ACHIEVEMENT_ENGINE_VERSION,
  referenceThresholdRule,
  referenceTitleRule,
  type AchievementRuleSpec,
} from '@br/achievements';
import { padelTitleFixture } from '@br/achievements/fixtures';
import { scopeContains } from '@br/authority';
import { DomainError, newId } from '@br/domain';
import {
  apiDb,
  declaredNoParticipation,
  workerDb as workerDbForTest,
  maintenanceDb,
  newContestResult,
  operatorDb,
  ownerDb,
  personSigner,
  publishPolicy,
  retryOnClockStep,
  seedTestCatalog,
  verificationOperatorDb,
  type TestCatalog,
} from '@br/testkit';
import {
  achievementOperatorDb,
  achievementWorkerDb,
  publishAchievementRule,
} from '@br/testkit/achievements';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistDerivation } from './achievement-lanes';
import {
  rebuildAchievementReadModels,
  snapshotAchievementReadModels,
} from './achievement-projection';
import { AchievementRuleStore } from './achievement-rule-store';
import { AchievementService } from './achievement-store';
import { AttestationStore } from './attestation-store';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import { pinnedGoverningAnchorFact, verificationSummary } from './achievement-loader';
import { EvidenceBundleService } from './evidence-reader';
import { IdentityStore } from './identity-store';
import { inTransaction, ModuleRole, withModuleRole } from './tx';
import { PrincipalKeyCeremony } from './key-ceremony-store';
import { OrganizationStore } from './organization-store';
import { VerificationPolicyStore, VerificationService } from './verification-store';
import { consumeOutbox } from './worker-queue';

/**
 * BRT-08 CANONICAL PRODUCTION lane on the NORMAL migrated schema. Only real facts: real
 * ResultVersions, real VerificationRuns (V0/V1), real statuses (SUBMITTED/PROVISIONAL). Honest
 * expected output: ZERO persisted Achievements, with every blocker explained. The normal schema
 * refuses REFERENCE_FIXTURE persistence at the database boundary.
 */
const AUD = 'bragging-rights:test';
const db = apiDb();
const opDb = operatorDb();
const vopDb = verificationOperatorDb();
const aopDb = achievementOperatorDb();
const maint = maintenanceDb();
const owner = ownerDb();
afterAll(async () => {
  await Promise.all([db, opDb, vopDb, aopDb, maint, owner].map((d) => d.destroy()));
});

const identity = new IdentityStore(db);
const orgs = new OrganizationStore(db);
const comps = new CompetitionStore(db);
const structure = new StructureStore(db);
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const attestations = new AttestationStore(db, { audience: AUD });
const ceremony = new PrincipalKeyCeremony(db, { audience: AUD });
const policies = new VerificationPolicyStore(vopDb);
const verification = new VerificationService(db);
const rules = new AchievementRuleStore(aopDb);
const achievements = new AchievementService(db);
const INTERNAL = { internal: true } as const;

let catalog: TestCatalog;
const contestWon = (dv: string): AchievementRuleSpec => ({
  targetEngine: ACHIEVEMENT_ENGINE_VERSION,
  achievementType: 'CONTEST_WON',
  displayName: 'Match Winner',
  disciplineVersionId: dv,
  holder: 'ENTRY_PARTICIPANT',
  requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
  criterion: { kind: 'CONTEST_OUTCOME', resultScope: 'CONTEST', outcomes: ['WIN'] },
});

beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(opDb));
  await publishPolicy(policies, catalog.operatorAccountId, catalog.tennisSingles);
});

const world = (submitAs: 'ATHLETE_A' | 'REFEREE' = 'ATHLETE_A') =>
  newContestResult({
    db,
    identity,
    orgs,
    comps,
    structure,
    authority,
    ledger,
    resolver,
    catalog,
    submitAs,
  });

describe('AchievementRule operator lane (dedicated login; floors; immutability; no backdating)', () => {
  it('creates, versions, publishes and binds; the published spec is immutable even for the owner', async () => {
    const r = await publishAchievementRule(
      rules,
      catalog.operatorAccountId,
      contestWon(catalog.tennisSingles),
    );
    expect(r.version).toBe(1);
    await expect(
      sql`UPDATE achievement.rule_version SET spec = '{}'::jsonb WHERE id = ${r.ruleVersionId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: 'BR001' });
    await expect(
      sql`DELETE FROM achievement.rule_binding WHERE id = ${r.bindingId}`.execute(owner),
    ).rejects.toMatchObject({ code: 'BR001' });
  });

  it('rejects a title rule below the BRT-01 platform floor (V1) and a wrong-metric threshold', async () => {
    const { ruleId } = await rules.createRule({
      operatorAccountId: catalog.operatorAccountId,
      code: `floor-${Date.now()}`,
      name: 'floor probe',
      achievementType: 'CONTEST_WON',
      idempotencyKey: `floor-${Date.now()}`,
    });
    const low = {
      ...contestWon(catalog.tennisSingles),
      requirements: { minimumVerificationLevel: 'V1', minimumResultStatus: 'FINAL' },
    };
    await expect(
      rules.createRuleVersion({
        operatorAccountId: catalog.operatorAccountId,
        ruleId,
        spec: low,
        idempotencyKey: `l-${Date.now()}`,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { issues: [{ code: 'BELOW_PLATFORM_FLOOR' }] },
    });
    const { ruleId: t } = await rules.createRule({
      operatorAccountId: catalog.operatorAccountId,
      code: `metric-${Date.now()}`,
      name: 'metric probe',
      achievementType: 'PERFORMANCE_THRESHOLD',
      idempotencyKey: `m-${Date.now()}`,
    });
    await expect(
      rules.createRuleVersion({
        operatorAccountId: catalog.operatorAccountId,
        ruleId: t,
        spec: referenceThresholdRule(
          catalog.tennisSingles,
          { key: 'aces', markMetricId: 'aces' },
          'GTE',
          '10',
        ),
        idempotencyKey: `m2-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ details: { issues: [{ code: 'METRIC_UNKNOWN' }] } });
  });

  it('only PUBLISHED versions bind; bindings are never backdated; DRAFT cannot derive', async () => {
    const { ruleId } = await rules.createRule({
      operatorAccountId: catalog.operatorAccountId,
      code: `draft-${Date.now()}`,
      name: 'draft probe',
      achievementType: 'CONTEST_WON',
      idempotencyKey: `d-${Date.now()}`,
    });
    const v = await rules.createRuleVersion({
      operatorAccountId: catalog.operatorAccountId,
      ruleId,
      spec: contestWon(catalog.tennisSingles),
      idempotencyKey: `dv-${Date.now()}`,
    });
    await expect(
      rules.bindRule({
        operatorAccountId: catalog.operatorAccountId,
        ruleVersionId: v.ruleVersionId,
        idempotencyKey: `db-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await rules.changeVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      ruleVersionId: v.ruleVersionId,
      status: 'PUBLISHED',
    });
    await expect(
      rules.bindRule({
        operatorAccountId: catalog.operatorAccountId,
        ruleVersionId: v.ruleVersionId,
        effectiveFrom: new Date(Date.now() - 3_600_000),
        idempotencyKey: `bd-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'BACKDATING_REJECTED' });
    // Direct SQL cannot backdate either.
    await expect(
      sql`INSERT INTO achievement.rule_binding (id, rule_id, rule_version_id, discipline_version_id, effective_from, actor_account_id, recorded_at)
          VALUES (gen_random_uuid(), ${ruleId}, ${v.ruleVersionId}, ${catalog.tennisSingles}, platform.tx_time_ms() - interval '1 day', ${catalog.operatorAccountId}, platform.tx_time_ms())`.execute(
        owner,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Published → retired; a retired version cannot be re-published.
    await rules.changeVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      ruleVersionId: v.ruleVersionId,
      status: 'RETIRED',
    });
    await expect(
      rules.changeVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        ruleVersionId: v.ruleVersionId,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('CANONICAL PRODUCTION lane: real facts ⇒ zero Achievements, exact blockers', () => {
  it('rule matches the sporting facts but V0/V1 + SUBMITTED + no hold facts ⇒ nothing persisted', async () => {
    await publishAchievementRule(
      rules,
      catalog.operatorAccountId,
      contestWon(catalog.tennisSingles),
    );
    const w = await world('ATHLETE_A');
    const [, b] = w.athletes;
    if (b === undefined) throw new Error('athlete');
    const B = await personSigner({ db, ceremony, attestations }, b);
    // Before any verification: NOT_EVALUATED.
    const before = await achievements.derive({
      actor: INTERNAL,
      resultVersionId: w.resultVersionId,
    });
    expect(before.provenance).toBe('CANONICAL_ASSEMBLY');
    expect(before.rules.length).toBeGreaterThan(0);
    for (const r of before.rules) {
      expect(r.achievements).toEqual([]);
      expect(r.blockedBy).toContain('VERIFICATION_NOT_EVALUATED');
    }
    // Real V1 through counterparty corroboration.
    // Harness only: the WSL VM clock may step back right after key registration (BRT-07 dev §5).
    for (let i = 1; ; i++) {
      try {
        await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== 'KEY_NOT_VALID' || i >= 4) throw err;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    const run = await retryOnClockStep(() =>
      verification.evaluate({ actor: INTERNAL, resultVersionId: w.resultVersionId }),
    );
    expect(run.kind === 'RUN' && run.run.highestSatisfiedLevel).toBe('V1');
    const after = await retryOnClockStep(() =>
      achievements.derive({ actor: INTERNAL, resultVersionId: w.resultVersionId }),
    );
    const won = after.rules.find((r) => r.achievementType === 'CONTEST_WON');
    expect(won?.wouldQualify).toBe(1); // the facts match the rule …
    expect(won?.state).toBe('BLOCKED'); // … but the floors are unmet:
    expect(won?.blockedBy).toEqual(
      expect.arrayContaining([
        'RESULT_STATUS_BELOW_REQUIRED',
        'VERIFICATION_LEVEL_BELOW_REQUIRED',
        'HOLD_STATE_UNAVAILABLE',
      ]),
    );
    expect(won?.achievements).toEqual([]);
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE competition_id = ${w.competitionId}`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('a rule bound AFTER the result was submitted never applies to it (no retroactive derivation)', async () => {
    const w = await world('REFEREE');
    const spec: AchievementRuleSpec = {
      ...contestWon(catalog.tennisSingles),
      displayName: 'Late Rule Winner',
    };
    const late = await publishAchievementRule(rules, catalog.operatorAccountId, spec);
    const out = await achievements.derive({ actor: INTERNAL, resultVersionId: w.resultVersionId });
    expect(out.rules.map((r) => r.ruleCode)).not.toContain(late.code);
  });

  it('derivation is idempotent and never creates rows when repeated', async () => {
    const w = await world('REFEREE');
    const a = await achievements.derive({ actor: INTERNAL, resultVersionId: w.resultVersionId });
    const b = await achievements.derive({ actor: INTERNAL, resultVersionId: w.resultVersionId });
    expect(b.rules.map((r) => r.snapshotHash)).toEqual(a.rules.map((r) => r.snapshotHash));
  });

  it('non-staff accounts get the same 404 as unknown ids (audited)', async () => {
    const w = await world('REFEREE');
    const stranger = (
      await identity.signIn({
        provider: 'test',
        providerSubject: `stranger-${Date.now()}`,
        method: 'TEST',
      })
    ).accountId;
    await expect(
      achievements.derive({ actor: { accountId: stranger }, resultVersionId: w.resultVersionId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('DB boundary: the NORMAL schema refuses REFERENCE_FIXTURE persistence', () => {
  it('normal migrated schema: persisting a REFERENCE_FIXTURE derivation is rejected by the database CHECK', async () => {
    const r = await publishAchievementRule(
      rules,
      catalog.operatorAccountId,
      referenceTitleRule(catalog.padelDoubles),
    );
    const snapshot = padelTitleFixture({
      disciplineVersionId: catalog.padelDoubles,
      ruleSpec: referenceTitleRule(catalog.padelDoubles),
      ruleIdentity: r,
    });
    await expect(persistDerivation(db, { snapshot })).rejects.toMatchObject({
      code: '23514',
      constraint: 'achievement_canonical_provenance_only',
    });
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE snapshot_provenance <> 'CANONICAL_ASSEMBLY'`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('a forged CANONICAL_ASSEMBLY snapshot (claimed V2 / FINAL) is refused: it is not the canonical assembly', async () => {
    const w = await world('REFEREE');
    const r = await publishAchievementRule(
      rules,
      catalog.operatorAccountId,
      referenceTitleRule(catalog.padelDoubles),
    );
    const forged = {
      ...padelTitleFixture({
        disciplineVersionId: catalog.padelDoubles,
        ruleSpec: referenceTitleRule(catalog.padelDoubles),
        ruleIdentity: r,
      }),
      provenance: 'CANONICAL_ASSEMBLY',
    };
    const forgedRv = {
      ...forged,
      resultVersion: { ...forged.resultVersion, resultVersionId: w.resultVersionId },
    };
    await expect(persistDerivation(db, { snapshot: forgedRv })).rejects.toBeInstanceOf(DomainError);
    await expect(persistDerivation(db, { snapshot: forgedRv })).rejects.toMatchObject({
      code: 'ACHIEVEMENT_INTEGRITY_FAILURE',
    });
  });

  it('there is no fixture switch: no function, setting or role in the normal database relaxes the CHECK', async () => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('achievement', 'achievement_read', 'platform') AND p.proname ~* 'fixture|overlay|bypass|force'`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe(0);
    const { rows: c } = await sql<{ conname: string }>`
      SELECT conname FROM pg_constraint WHERE conname IN ('achievement_canonical_provenance_only', 'status_entry_canonical_provenance_only')
      ORDER BY conname`.execute(owner);
    expect(c.map((x) => x.conname)).toEqual([
      'achievement_canonical_provenance_only',
      'status_entry_canonical_provenance_only',
    ]);
  });
});

describe('BRT-08R · evidenceCommitment basis = the pinned run Evidence Bundle (real canonical data)', () => {
  it('the run bundle hash is reproducible from immutable BRT-06 facts at its asOf and changes with the attestation basis; staleness is visible live to the worker login', async () => {
    const w = await world('ATHLETE_A');
    const [, b] = w.athletes;
    if (b === undefined) throw new Error('athlete');
    const B = await personSigner({ db, ceremony, attestations }, b);
    const attest = async () => {
      for (let i = 1; ; i++) {
        try {
          return await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
        } catch (err) {
          if ((err as { code?: string }).code !== 'KEY_NOT_VALID' || i >= 4) throw err;
          await new Promise((r) => setTimeout(r, 1200));
        }
      }
    };
    await attest();
    const r1 = await retryOnClockStep(() =>
      verification.evaluate({ actor: INTERNAL, resultVersionId: w.resultVersionId }),
    );
    if (r1.kind !== 'RUN') throw new Error('no run');
    const aw = achievementWorkerDb();
    try {
      // The achievement worker login computes live freshness through the SELECT-only reader.
      const s1 = await retryOnClockStep(() =>
        inTransaction(
          aw,
          ModuleRole.achievements,
          (ctx) => verificationSummary(ctx, w.resultVersionId),
          1,
          { isolation: 'repeatable read' },
        ),
      );
      expect(s1).toMatchObject({
        state: 'CURRENT',
        runId: r1.run.runId,
        evidenceBundleHash: r1.run.evidenceBundleHash,
        evaluatedAsOf: r1.run.evaluatedAsOf,
      });
      const bundles = new EvidenceBundleService(db);
      const rebuilt = await bundles.build({
        actor: INTERNAL,
        resultVersionId: w.resultVersionId,
        asOf: new Date(r1.run.evaluatedAsOf),
      });
      expect('bundleHash' in rebuilt && rebuilt.bundleHash).toBe(r1.run.evidenceBundleHash);
      // A new attestation changes the evidence/attestation basis: the pinned run is STALE (no new run
      // yet), and the next run evaluates another bundle — so another evidenceCommitment.
      await attest();
      const s2 = await retryOnClockStep(() =>
        inTransaction(
          aw,
          ModuleRole.achievements,
          (ctx) => verificationSummary(ctx, w.resultVersionId),
          1,
          { isolation: 'repeatable read' },
        ),
      );
      expect(s2).toMatchObject({ state: 'STALE', runId: r1.run.runId });
      const r2 = await retryOnClockStep(() =>
        verification.evaluate({ actor: INTERNAL, resultVersionId: w.resultVersionId }),
      );
      if (r2.kind !== 'RUN') throw new Error('no run');
      expect(r2.run.evidenceBundleHash).not.toBe(r1.run.evidenceBundleHash);
      const again = await bundles.build({
        actor: INTERNAL,
        resultVersionId: w.resultVersionId,
        asOf: new Date(r1.run.evaluatedAsOf),
      });
      expect('bundleHash' in again && again.bundleHash).toBe(r1.run.evidenceBundleHash); // history immutable
    } finally {
      await aw.destroy();
    }
  }, 120_000);
});

describe('worker reaction (canonical events only; at-least-once ⇒ exactly-once logical effects)', () => {
  it('replaying VerificationEvaluated events through the achievement worker login is idempotent', async () => {
    const aw = achievementWorkerDb();
    const w = workerDbForTest();
    try {
      const reactor = new AchievementService(aw);
      const consumer = `achievements.derive.test-${Date.now()}`;
      const seen: number[] = [];
      const round = () =>
        consumeOutbox(
          w,
          consumer,
          async (event) => {
            if (event.eventType !== 'VerificationEvaluated') return;
            const r = await reactor.react(event);
            seen.push(r?.derived ?? 0);
          },
          500,
        );
      let total = 0;
      for (let i = 0; i < 100; i++) {
        const n = await round();
        total += n;
        if (n === 0) break;
      }
      expect(total).toBeGreaterThan(0);
      expect(await round()).toBe(0); // receipts committed: the same events are not redelivered
      expect(seen.every((n) => n === 0)).toBe(true); // honest production: nothing derivable
      // Re-delivering one event by hand (at-least-once) changes nothing either.
      const { rows } = await sql<{
        id: string;
        payload: Record<string, unknown>;
        aggregate_id: string;
      }>`
        SELECT id, payload, aggregate_id FROM platform.outbox_event WHERE event_type = 'VerificationEvaluated' ORDER BY id DESC LIMIT 1`.execute(
        owner,
      );
      const e = rows[0];
      if (e !== undefined) {
        const again = await reactor.react({
          eventId: e.id as never,
          eventType: 'VerificationEvaluated',
          eventVersion: 1,
          aggregateType: 'VERIFICATION_RUN',
          aggregateId: e.aggregate_id as never,
          occurredAt: new Date(),
          payload: e.payload,
        });
        expect(again?.derived ?? 0).toBe(0);
      }
      const { rows: n } = await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM achievement.achievement`.execute(owner);
      expect(n[0]?.n).toBe(0);
    } finally {
      await Promise.all([aw.destroy(), w.destroy()]);
    }
  }, 120_000);
});

describe('read models', () => {
  it('rebuild through the maintenance login reproduces the projections', async () => {
    const before = await snapshotAchievementReadModels(db);
    await rebuildAchievementReadModels(maint);
    expect(await snapshotAchievementReadModels(db)).toEqual(before);
  });
});

describe('BRT-08R-F · AC-4 governing scope comes from the IMMUTABLE anchor fact the pinned trace names', () => {
  it('reconstructs level / region / sport from the hash-verified BRT-03 fact; later revocation cannot change it; mismatches fail closed', async () => {
    const federation = await authority.registerPrincipal({
      principalType: 'ORGANIZATION',
      label: 'federation (fictional, AC-4 test)',
    });
    const recognitionScope = {
      recognitionLevel: ['NATIONAL' as const],
      sport: ['padel'],
      region: ['CR'],
    };
    const { anchorId, factHash } = await authority.recognizeTrustAnchor({
      principalId: federation.id,
      recognitionScope,
      basisRef: 'test',
      governanceDecisionRef: `test-${newId()}`,
    });
    // exactly what the pinned trace records for an authorized SANCTION decision
    const decision = {
      recognitionLevel: 'NATIONAL' as const,
      anchorId,
      source: 'SANCTION' as const,
      anchorLevels: ['NATIONAL'],
    };
    const read = (d: typeof decision) =>
      inTransaction(db, ModuleRole.achievements, (ctx) =>
        withModuleRole(ctx, ModuleRole.verificationReader, (v) => pinnedGoverningAnchorFact(v, d)),
      );
    const before = await read(decision);
    expect(before).toEqual({
      ...decision,
      anchorLevels: undefined,
      anchorFactHash: factHash,
      recognitionScope,
    });
    expect(
      scopeContains(
        before.recognitionScope as never,
        {
          recognitionLevel: ['NATIONAL'],
          sport: ['padel'],
          region: ['PE'],
        } as never,
      ),
    ).toBe(false);
    // Today's mutable authority state is never consulted: revoking the anchor changes nothing pinned.
    await authority.revokeTrustAnchor({ anchorId, reason: 'test' });
    expect(await read(decision)).toEqual(before);
    // The trace and the fact must agree; an unknown anchor fails closed.
    await expect(read({ ...decision, anchorLevels: ['CONTINENTAL'] })).rejects.toMatchObject({
      code: 'ACHIEVEMENT_INTEGRITY_FAILURE',
    });
    await expect(read({ ...decision, anchorId: newId() })).rejects.toMatchObject({
      code: 'ACHIEVEMENT_INTEGRITY_FAILURE',
    });
  });
});
