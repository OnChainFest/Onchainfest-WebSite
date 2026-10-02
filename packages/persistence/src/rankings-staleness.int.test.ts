import { newId, type AuthorityScope, type Uuid } from '@br/domain';
import { classificationDependencies } from '@br/rankings';
import { rankCandidate, rankingRunInput, rankingSpec } from '@br/rankings/fixtures';
import {
  apiDb,
  declaredNoParticipation,
  newContestResult,
  newTestAccount,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  type TestCatalog,
} from '@br/testkit';
import {
  createRankingFixtureDatabase,
  rankingOperatorDb,
  rankingWorkerDb,
  type RankingFixtureDatabase,
} from '@br/testkit/rankings';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { CatalogStore } from './catalog-store';
import { ClassificationStalenessService } from './classification-staleness';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from './competition-hierarchy';
import { CompetitionStore } from './competition-store';
import { StructureStore } from './competition-structure-store';
import {
  databaseUrls,
  operatorDatabaseUrl,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
} from './config';
import { createDb, type Db } from './db';
import { IdentityStore } from './identity-store';
import { OrganizationStore } from './organization-store';
import { RankingDefinitionStore } from './ranking-definition-store';
import { RankingHistoryReader } from './ranking-history';
import { persistRankingRun, publishRankingSnapshot } from './ranking-lanes';

/**
 * BRT-10 Step 7 — computed classification staleness, the derivedFrom / run dependency indexes,
 * correction impact, ClassificationStale and the as-published / as-corrected snapshot queries.
 *
 * The NORMAL schema holds only canonical facts. With no T7 / T8 producer a pinned contest input can
 * never stop being current there, so "pinned input not current" is exercised by the pure unit tests
 * (packages/rankings/src/staleness.test.ts); here a classification goes STALE the canonical way — a
 * new contest result is accepted into its scope. Snapshot lineage (CORRECTS) exists only in the
 * THROWAWAY br_rkfx_ lane with REFERENCE FIXTURES — NOT SPORTING TRUTH.
 */
const DENIED = { code: '42501' };
const k = (p = 'k') => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const countOf = async (db: Db, q: ReturnType<typeof sql<{ n: string }>>) =>
  Number((await q.execute(db)).rows[0]?.n ?? -1);

const api = apiDb();
const owner = ownerDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const op = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, rop, rw, op].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const definitions = new RankingDefinitionStore(rop);
const staleness = new ClassificationStalenessService(api);
let catalog: TestCatalog;

const scopeOf = async (level: 'CONTEST' | 'ROUND' | 'EVENT' | 'COMPETITION', id: string) =>
  ({ ...(await resolver.scopeOf(level, id)), recognitionLevel: ['PLATFORM'] }) as AuthorityScope;

/** A real timed contest (optionally a new event of an existing competition) + an ACCEPT_RESULT holder. */
async function contestWorld(
  timed: { winnerMs: string; loserMs: string },
  into?: {
    organizer: Awaited<ReturnType<typeof newContestResult>>['organizer'];
    competitionId: string;
  },
  acceptNow = true,
) {
  const w = await newContestResult({
    db: api,
    identity,
    orgs: new OrganizationStore(api),
    comps: new CompetitionStore(api),
    structure: new StructureStore(api),
    authority,
    ledger,
    resolver,
    catalog,
    timed,
    ...(into === undefined ? {} : into),
  });
  const acceptor = await authority.registerPrincipal({
    principalType: 'PERSON',
    label: 'fictional chief judge (fixture)',
  });
  await authority.issueGrant({
    actorPrincipalId: w.platformPrincipalId,
    grantorPrincipalId: w.platformPrincipalId,
    granteePrincipalId: acceptor.id,
    capabilities: ['ACCEPT_RESULT'],
    scope: { recognitionLevel: ['PLATFORM'], competition: [w.competitionId as Uuid] },
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  const accept = async () =>
    ledger.transition({
      resultVersionId: w.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: acceptor.id,
      scope: await scopeOf('CONTEST', w.contestId),
      idempotencyKey: k('accept'),
    });
  if (acceptNow) await accept();
  return { ...w, accept, acceptorId: acceptor.id };
}

async function submitClassification(
  w: { submitterPrincipalId: string },
  scopeType: 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION',
  targetId: string,
  scope: AuthorityScope,
) {
  const { id: resultId } = await ledger.createResult({
    scopeType,
    scopeTargetId: targetId as Uuid,
  });
  const p = await ledger.proposeClassification(resultId);
  if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined)
    throw new Error(`no proposal: ${JSON.stringify(p)}`);
  const { draftId } = await ledger.saveDraft({
    resultId,
    authorPrincipalId: w.submitterPrincipalId as Uuid,
    disciplineVersionRef: 'timed.singles@1',
    content: p.outcome.proposal.content,
  });
  const s = await ledger.submitDraft({
    draftId,
    actorPrincipalId: w.submitterPrincipalId as Uuid,
    scope,
    idempotencyKey: k('submit'),
  });
  return { resultId, versionId: s.resultVersionId, contentHash: s.contentHash };
}

const policySpec = (scopeType: string, displayName: string) => ({
  targetEngine: 'classification-engine/1',
  displayName,
  scopeType,
  disciplineVersionId: catalog.timedSingles,
  minimumInputStatus: 'PROVISIONAL',
  primary: 'METRICS',
  keys: [
    {
      metric: 'elapsedTimeMs',
      markMetricId: 'athletics.100m.time',
      order: 'LOWER_IS_BETTER',
      source: 'PERFORMANCE',
      aggregation: 'MIN',
    },
  ],
});

/** The PUBLISHED policy versions of (scope type, timed DV) — the unique-or-fail binding's candidates. */
async function publishedPolicyVersions(scopeType: string) {
  const { rows } = await sql<{ id: string }>`
    SELECT v.id::text AS id FROM ranking.classification_policy_version v
    JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = v.id
    WHERE v.scope_type = ${scopeType} AND v.discipline_version_id = ${catalog.timedSingles}
      AND s.status = 'PUBLISHED'`.execute(owner);
  return rows.map((r) => r.id);
}
const retire = (policyVersionId: string) =>
  definitions.changeClassificationPolicyVersionStatus({
    operatorAccountId: catalog.operatorAccountId,
    policyVersionId,
    status: 'RETIRED',
  });

/** Publishes the ONLY policy of the scope type (retiring any other: the binding is unique-or-fail). */
async function soleBinding(scopeType: string, displayName: string) {
  for (const id of await publishedPolicyVersions(scopeType)) await retire(id);
  const { policyId } = await definitions.createClassificationPolicy({
    operatorAccountId: catalog.operatorAccountId,
    code: `cp-${newId().slice(-12)}`,
    name: 'Fictional table',
    scopeType,
    idempotencyKey: k('cp'),
  });
  const v = await definitions.createClassificationPolicyVersion({
    operatorAccountId: catalog.operatorAccountId,
    policyId,
    spec: policySpec(scopeType, displayName),
    idempotencyKey: k('cpv'),
  });
  await definitions.changeClassificationPolicyVersionStatus({
    operatorAccountId: catalog.operatorAccountId,
    policyVersionId: v.policyVersionId,
    status: 'PUBLISHED',
  });
  return v.policyVersionId;
}

/** Row counts of every table a read could (wrongly) write. */
const footprint = async () =>
  Promise.all([
    countOf(owner, sql`SELECT count(*)::text AS n FROM results.result_version`),
    countOf(owner, sql`SELECT count(*)::text AS n FROM results.result_status_transition`),
    countOf(owner, sql`SELECT count(*)::text AS n FROM results.classification_derivation`),
    countOf(owner, sql`SELECT count(*)::text AS n FROM results.classification_input`),
    countOf(owner, sql`SELECT count(*)::text AS n FROM platform.outbox_event`),
    countOf(owner, sql`SELECT count(*)::text AS n FROM platform.audit_event`),
  ]);

beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(op));
}, 120_000);

// ═════════════════════════════ classifications (canonical lane) ═════════════════════════════

describe('classification staleness, dependency index and correction impact (canonical facts only)', () => {
  let w: Awaited<ReturnType<typeof contestWorld>>;
  let other: Awaited<ReturnType<typeof contestWorld>>;
  let comp: Awaited<ReturnType<typeof submitClassification>>;
  let evt: Awaited<ReturnType<typeof submitClassification>>;
  let unrelated: Awaited<ReturnType<typeof submitClassification>>;
  let compPolicy: string;
  let frozenContent: string;
  const policies: string[] = [];

  beforeAll(async () => {
    compPolicy = await soleBinding('COMPETITION_CLASSIFICATION', 'Fictional competition table');
    policies.push(compPolicy, await soleBinding('EVENT_CLASSIFICATION', 'Fictional event table'));
    w = await contestWorld({ winnerMs: '10870', loserMs: '11020' });
    other = await contestWorld({ winnerMs: '10900', loserMs: '11000' });
    comp = await submitClassification(
      w,
      'COMPETITION_CLASSIFICATION',
      w.competitionId,
      await scopeOf('COMPETITION', w.competitionId),
    );
    evt = await submitClassification(
      w,
      'EVENT_CLASSIFICATION',
      w.eventId,
      await scopeOf('EVENT', w.eventId),
    );
    unrelated = await submitClassification(
      other,
      'EVENT_CLASSIFICATION',
      other.eventId,
      await scopeOf('EVENT', other.eventId),
    );
    const { rows } = await sql<{ content: unknown }>`
      SELECT content FROM results.result_version WHERE id = ${comp.versionId}`.execute(owner);
    frozenContent = JSON.stringify(rows[0]?.content);
  }, 300_000);
  afterAll(async () => {
    // Leave no binding behind for other files (the binding is global per scope type + DV).
    for (const s of ['COMPETITION_CLASSIFICATION', 'EVENT_CLASSIFICATION'])
      for (const id of await publishedPolicyVersions(s)) await retire(id);
  });

  it('1 & 18. a fresh classification reads CURRENT, with its exact pins inspectable', async () => {
    const r = await staleness.read(comp.versionId);
    expect(r).toMatchObject({
      classificationVersionId: comp.versionId,
      resultId: comp.resultId,
      scopeType: 'COMPETITION_CLASSIFICATION',
      status: 'SUBMITTED',
      contentSchema: 'br:result-version-content@2',
      contentHash: comp.contentHash,
      staleness: { state: 'CURRENT' },
    });
    expect(r.derivation?.derivedFrom).toEqual([
      { resultVersionId: w.resultVersionId, contentHash: w.contentHash, status: 'PROVISIONAL' },
    ]);
    expect(r.derivation?.policy.policyVersionId).toBe(compPolicy);
  });

  it('8–11. the derivedFrom index: every dependent, shared dependencies, nothing unrelated, stable', async () => {
    const deps = await staleness.dependents(w.resultVersionId);
    expect(deps).toEqual([comp.versionId, evt.versionId].sort());
    expect(await staleness.dependents(other.resultVersionId)).toEqual([unrelated.versionId]);
    expect(await staleness.dependents(newId())).toEqual([]);
    expect(await staleness.dependents(w.resultVersionId)).toEqual(deps);
  });

  it('12. the index equals the content pins of every dependent (asserted on every read)', async () => {
    for (const v of [comp, evt, unrelated]) {
      const { rows } = await sql<{ content: unknown }>`
        SELECT content FROM results.result_version WHERE id = ${v.versionId}`.execute(owner);
      const d = classificationDependencies(rows[0]?.content);
      if (!d.ok) throw new Error('provenance');
      const { rows: idx } = await sql<{ id: string; hash: string }>`
        SELECT input_result_version_id::text AS id, input_content_hash AS hash FROM results.classification_input
        WHERE classification_version_id = ${v.versionId} ORDER BY 1`.execute(owner);
      expect(idx).toEqual(
        d.derivation.derivedFrom.map((p) => ({ id: p.resultVersionId, hash: p.contentHash })),
      );
    }
  });

  it('13–16. correction impact via the index: dependents only, no impact while every pin is current', async () => {
    const impact = await staleness.correctionImpact(w.resultVersionId);
    expect(impact).toEqual(
      [comp, evt]
        .map((v) => ({ classificationVersionId: v.versionId, resultId: v.resultId, impact: [] }))
        .sort((a, b) => (a.classificationVersionId < b.classificationVersionId ? -1 : 1)),
    );
    expect(await staleness.correctionImpact(newId())).toEqual([]);
  });

  it('4. an unrelated changed result leaves a classification CURRENT', async () => {
    await other.submitNextVersion(); // a new SUBMITTED version in another competition
    expect((await staleness.read(comp.versionId)).staleness.state).toBe('CURRENT');
    expect((await staleness.read(unrelated.versionId)).staleness.state).toBe('CURRENT');
  });

  it('rebinding the policy is not a stale condition (admissibility uses the PINNED policy)', async () => {
    await soleBinding('COMPETITION_CLASSIFICATION', 'Fictional competition table two');
    expect((await staleness.read(comp.versionId)).staleness.state).toBe('CURRENT');
  });

  it('5, 19 & 2. a new admissible input in scope ⇒ STALE (only for the scope it enters); SUBMITTED alone is not admissible', async () => {
    const second = await contestWorld(
      { winnerMs: '10950', loserMs: '11050' },
      { organizer: w.organizer, competitionId: w.competitionId },
      false,
    );
    // SUBMITTED only: not admissible ⇒ the admissible set is unchanged (a missing contest is not a change).
    expect((await staleness.read(comp.versionId)).staleness.state).toBe('CURRENT');
    await second.accept();
    const before = await footprint();
    const r = await staleness.read(comp.versionId);
    if (r.staleness.state !== 'STALE') throw new Error(`must be stale: ${JSON.stringify(r)}`);
    expect(r.staleness.document).toMatchObject({
      classificationVersionId: comp.versionId,
      contentHash: comp.contentHash,
      reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'],
      notCurrent: [],
      added: [{ resultVersionId: second.resultVersionId, contentHash: second.contentHash }],
      removed: [],
    });
    // The event of the first contest is a different scope: still CURRENT (no false positive).
    expect((await staleness.read(evt.versionId)).staleness.state).toBe('CURRENT');
    // Reading computed staleness wrote nothing and left the historical version untouched.
    expect(await footprint()).toEqual(before);
    const { rows } = await sql<{ content: unknown }>`
      SELECT content FROM results.result_version WHERE id = ${comp.versionId}`.execute(owner);
    expect(JSON.stringify(rows[0]?.content)).toBe(frozenContent);
    // The impact of the old pin is still none: it is current — the set grew, nothing was corrected.
    const impact = await staleness.correctionImpact(w.resultVersionId);
    expect(impact.every((i) => i.impact.length === 0)).toBe(true);
  });

  it('7. repeated reads of the same state are byte-identical (deterministic digest)', async () => {
    const a = await staleness.read(comp.versionId);
    const b = await staleness.read(comp.versionId);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('21. the STALE current classification is not replaced: the re-derived proposal stays blocked without T7', async () => {
    // "Current" is the accepted version (T3, ACCEPT_RESULT — unchanged). While a classification is only
    // SUBMITTED, a competing submission is ordinary ledger behaviour, exactly as for contest results.
    await ledger.transition({
      resultVersionId: comp.versionId as Uuid,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: w.acceptorId,
      scope: await scopeOf('COMPETITION', w.competitionId),
      idempotencyKey: k('accept-classification'),
    });
    const p = await ledger.proposeClassification(comp.resultId);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined) throw new Error('no proposal');
    expect(p.outcome.proposal.contentHash).not.toBe(comp.contentHash);
    const { draftId } = await ledger.saveDraft({
      resultId: comp.resultId as Uuid,
      authorPrincipalId: w.submitterPrincipalId as Uuid,
      disciplineVersionRef: 'timed.singles@1',
      content: p.outcome.proposal.content,
    });
    await expect(
      ledger.submitDraft({
        draftId,
        actorPrincipalId: w.submitterPrincipalId as Uuid,
        scope: await scopeOf('COMPETITION', w.competitionId),
        idempotencyKey: k('replace'),
      }),
    ).rejects.toMatchObject({
      code: 'CURRENT_VERSION_CONFLICT',
      details: {
        reason: 'CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION',
        currentVersionId: comp.versionId,
      },
    });
    expect(
      await countOf(
        owner,
        sql`SELECT count(*)::text AS n FROM results.result_version WHERE result_id = ${comp.resultId}`,
      ),
    ).toBe(1);
    expect((await staleness.read(comp.versionId)).staleness.state).toBe('STALE');
  });

  it('22–24. ClassificationStale: one event per (version, staleDigest), even when repeated concurrently', async () => {
    const eventsOf = (id: string) =>
      sql<{ id: string; payload: Record<string, unknown> }>`
        SELECT id::text AS id, payload FROM platform.outbox_event
        WHERE event_type = 'ClassificationStale' AND aggregate_id = ${id} ORDER BY recorded_at, id`.execute(
        owner,
      );
    const first = await staleness.emitStale(comp.versionId);
    expect(first).toMatchObject({ state: 'STALE', emitted: true });
    const again = await Promise.all([1, 2, 3, 4].map(() => staleness.emitStale(comp.versionId)));
    expect(again.every((x) => !x.emitted && x.eventId === first.eventId)).toBe(true);
    const { rows } = await eventsOf(comp.versionId);
    expect(rows).toHaveLength(1);
    const read = await staleness.read(comp.versionId);
    if (read.staleness.state !== 'STALE') throw new Error('stale');
    expect(rows[0]?.payload).toEqual({
      resultId: comp.resultId,
      classificationVersionId: comp.versionId,
      contentHash: comp.contentHash,
      inputsDigest: read.derivation?.inputsDigest,
      staleDigest: read.staleness.staleDigest,
      reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'],
      notCurrent: [],
      added: read.staleness.document.added.map((p) => p.resultVersionId),
      removed: [],
    });
    expect(first.staleDigest).toBe(read.staleness.staleDigest);
    // A CURRENT classification emits nothing.
    expect(await staleness.emitStale(evt.versionId)).toEqual({ state: 'CURRENT', emitted: false });
    expect((await eventsOf(evt.versionId)).rows).toHaveLength(0);
    // Emitting changed nothing but the outbox: the version is still the same immutable fact.
    const { rows: v } = await sql<{ content: unknown }>`
      SELECT content FROM results.result_version WHERE id = ${comp.versionId}`.execute(owner);
    expect(JSON.stringify(v[0]?.content)).toBe(frozenContent);
  });

  it('a different stale state (a new digest) is a new ClassificationStale event', async () => {
    const before = await staleness.read(comp.versionId);
    await contestWorld(
      { winnerMs: '10990', loserMs: '11090' },
      {
        organizer: w.organizer,
        competitionId: w.competitionId,
      },
    );
    const after = await staleness.read(comp.versionId);
    if (before.staleness.state !== 'STALE' || after.staleness.state !== 'STALE')
      throw new Error('stale');
    expect(after.staleness.staleDigest).not.toBe(before.staleness.staleDigest);
    expect(after.staleness.document.added).toHaveLength(2);
    expect(await staleness.emitStale(comp.versionId)).toMatchObject({
      emitted: true,
      staleDigest: after.staleness.staleDigest,
    });
    expect(
      await countOf(
        owner,
        sql`SELECT count(*)::text AS n FROM platform.outbox_event
            WHERE event_type = 'ClassificationStale' AND aggregate_id = ${comp.versionId}`,
      ),
    ).toBe(2);
  });

  it('6. a legacy `@1` classification is never treated as derived: CLASSIFICATION_PROVENANCE_UNAVAILABLE', async () => {
    const { id: resultId } = await ledger.createResult({
      scopeType: 'EVENT_CLASSIFICATION',
      scopeTargetId: other.eventId as Uuid,
    });
    const [p1, p2] = other.participantIds as [string, string];
    const { draftId } = await ledger.saveDraft({
      resultId: resultId as Uuid,
      authorPrincipalId: other.submitterPrincipalId as Uuid,
      disciplineVersionRef: 'timed.singles@1',
      content: {
        entries: [
          { participantId: p1, outcome: 'WIN' },
          { participantId: p2, outcome: 'LOSS' },
        ],
      },
    });
    const legacy = await ledger.submitDraft({
      draftId,
      actorPrincipalId: other.submitterPrincipalId as Uuid,
      scope: await scopeOf('EVENT', other.eventId),
      idempotencyKey: k('legacy'),
    });
    const r = await staleness.read(legacy.resultVersionId);
    expect(r).toMatchObject({
      contentSchema: 'br:result-version-content@1',
      staleness: { state: 'PROVENANCE_UNAVAILABLE', code: 'CLASSIFICATION_PROVENANCE_UNAVAILABLE' },
    });
    expect(r.derivation).toBeUndefined();
    expect(await staleness.emitStale(legacy.resultVersionId)).toEqual({
      state: 'PROVENANCE_UNAVAILABLE',
      emitted: false,
    });
    expect(await staleness.dependents(other.resultVersionId)).toEqual([unrelated.versionId]);
  });

  it('a CONTEST ResultVersion is not a classification (refused, never read as one)', async () => {
    await expect(staleness.read(w.resultVersionId)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'NOT_A_CLASSIFICATION_RESULT' },
    });
    await expect(staleness.read(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('25–26. role boundaries: no write path on the index, no UPDATE / DELETE, PUBLIC holds nothing', async () => {
    const { rows } = await sql<{ role: string; t: string; priv: string; has: boolean }>`
      SELECT r.role, t.t, p.priv, has_table_privilege(r.role, t.t, p.priv) AS has
      FROM (VALUES ('br_results'), ('br_rankings'), ('br_api'), ('br_public_read'), ('br_worker')) r(role),
           (VALUES ('results.classification_input'), ('results.classification_derivation'),
                   ('ranking.snapshot'), ('ranking.run_dependency')) t(t),
           (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)`.execute(owner);
    expect(rows.filter((r) => r.has)).toEqual([]);
    const { rows: ins } = await sql<{ role: string; t: string; has: boolean }>`
      SELECT r.role, t.t, has_table_privilege(r.role, t.t, 'INSERT') AS has
      FROM (VALUES ('br_rankings'), ('br_api'), ('br_public_read'), ('br_worker')) r(role),
           (VALUES ('results.classification_input'), ('results.classification_derivation'),
                   ('results.result_version')) t(t)`.execute(owner);
    expect(ins.filter((r) => r.has)).toEqual([]);
    const { rows: pub } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND table_schema IN ('results', 'ranking', 'platform')`.execute(
      owner,
    );
    expect(pub[0]?.n).toBe('0');
    // br_api cannot reach the ranking runtime role: the snapshot reader is unusable from the API login.
    await expect(new RankingHistoryReader(api).asPublished(newId())).rejects.toMatchObject(DENIED);
  });
});

// ═════════════════════════════ ranking snapshots (as-published / as-corrected) ═════════════════════════════

describe('ranking snapshot history: as-published vs as-corrected are queries; STALE is computed', () => {
  it('the canonical lane has no snapshot to read (no FINAL producer): empty views, NOT_FOUND, empty index', async () => {
    const history = new RankingHistoryReader(rw);
    expect(await history.asPublished(newId())).toEqual([]);
    expect(await history.asCorrected(newId())).toEqual([]);
    await expect(history.read(newId())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await history.dependents('RESULT_VERSION', newId())).toEqual([]);
  });

  describe('REFERENCE FIXTURE lane (br_rkfx_*)', () => {
    let fx: RankingFixtureDatabase;
    const fdbs: Db[] = [];
    let fw: Db;
    let fowner: Db;
    let history: RankingHistoryReader;
    let systemId: string;
    let systemVersionId: string;
    const snaps: Record<string, string> = {};

    beforeAll(async () => {
      fx = await createRankingFixtureDatabase();
      const urls = databaseUrls(fx.database);
      const mk = (u: string | undefined) => {
        const d = createDb(u as string, { max: 3 });
        fdbs.push(d);
        return d;
      };
      const fapi = mk(urls.api);
      fowner = mk(urls.owner);
      fw = mk(rankingWorkerDatabaseUrl(fx.database));
      history = new RankingHistoryReader(fw);
      const fop = new RankingDefinitionStore(mk(rankingOperatorDatabaseUrl(fx.database)));
      const fidentity = new IdentityStore(fapi);
      const fcat = await seedTestCatalog(
        fidentity,
        new CatalogStore(mk(operatorDatabaseUrl(fx.database))),
      );
      const operatorAccountId = (
        await newTestAccount(fidentity, { withPerson: false, label: 'rk-op' })
      ).accountId;
      const dv = fcat.running5k;
      const { rows } = await sql<{ sport: string; discipline: string }>`
        SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
        JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
        WHERE v.id = ${dv}`.execute(fowner);
      const codes = rows[0] as { sport: string; discipline: string };
      const eff = futureIso(3);
      const { systemId: sid } = await fop.createRankingSystem({
        operatorAccountId,
        code: `rk-${newId().slice(-12)}`,
        name: 'Fictional best marks',
        kind: 'PLATFORM',
        idempotencyKey: k('rs'),
      });
      const v = await fop.createRankingSystemVersion({
        operatorAccountId,
        systemId: sid,
        spec: rankingSpec({
          universe: {
            disciplineVersionId: dv,
            metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
            resultScope: 'CONTEST',
            holderType: 'ATHLETE',
            population: {},
          },
          recognition: { level: 'PLATFORM', sport: [codes.sport] },
          effectiveFrom: eff,
        }),
        idempotencyKey: k('rsv'),
      });
      await fop.changeRankingSystemVersionStatus({
        operatorAccountId,
        systemVersionId: v.systemVersionId,
        status: 'PUBLISHED',
      });
      systemId = sid;
      systemVersionId = v.systemVersionId;
      const { rows: sv } = await sql<{ spec: Record<string, unknown>; code: string }>`
        SELECT v.spec, s.code FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
        WHERE v.id = ${v.systemVersionId}`.execute(fowner);
      const row = sv[0] as { spec: Record<string, unknown>; code: string };
      const later = (m: number) => new Date(Date.parse(eff) + m * 60_000).toISOString();
      const cand = (n: number, holder: number, value: string) =>
        rankCandidate(n, holder, value, { occurredAt: later(60) });
      const publish = async (candidates: unknown[], asOfMin: number, correction?: string) => {
        const r = await persistRankingRun(fw, {
          input: rankingRunInput(candidates, {
            spec: row.spec,
            system: {
              systemId: sid,
              systemVersionId: v.systemVersionId,
              code: row.code,
              version: v.version,
              specHash: v.specHash,
              lifecycle: 'PUBLISHED',
            },
            discipline: {
              disciplineVersionId: dv,
              sport: codes.sport,
              discipline: codes.discipline,
            },
            asOf: later(asOfMin),
          }),
          trigger: 'STAFF_REQUEST',
        });
        return (
          await publishRankingSnapshot(fw, {
            runId: r.runId,
            ...(correction === undefined
              ? {}
              : { correction: { correctsSnapshotId: correction, reasons: ['RESULT_SUPERSEDED'] } }),
          })
        ).snapshotId;
      };
      // INITIAL a → FOLLOWS b → CORRECTS b (c) → CORRECTS c (d) → FOLLOWS d (e)
      snaps.a = await publish([cand(1, 1, '900000')], 120);
      snaps.b = await publish([cand(1, 1, '900000'), cand(2, 2, '901000')], 130);
      snaps.c = await publish([cand(2, 2, '901000')], 140, snaps.b);
      snaps.d = await publish([cand(2, 2, '902000')], 150, snaps.c);
      snaps.e = await publish([cand(2, 2, '902000'), cand(3, 3, '903000')], 160);
    }, 300_000);
    afterAll(async () => {
      await Promise.all(fdbs.map((d) => d.destroy()));
      await fx.destroy();
    }, 60_000);

    it('as-published is the whole chronological lineage; corrected snapshots name their correction', async () => {
      const list = await history.asPublished(systemId);
      expect(list.map((s) => s.snapshotId)).toEqual([snaps.a, snaps.b, snaps.c, snaps.d, snaps.e]);
      expect(list.map((s) => s.lineageKind)).toEqual([
        'INITIAL',
        'FOLLOWS',
        'CORRECTS',
        'CORRECTS',
        'FOLLOWS',
      ]);
      expect(list.map((s) => s.correctedBy)).toEqual([
        undefined,
        snaps.c,
        snaps.d,
        undefined,
        undefined,
      ]);
      expect(list.every((s) => s.provenance === 'REFERENCE_FIXTURE')).toBe(true);
    });

    it('as-corrected replaces each corrected snapshot by its final correction; the last item is current', async () => {
      const list = await history.asCorrected(systemId);
      expect(list.map((s) => s.snapshotId)).toEqual([snaps.a, snaps.d, snaps.e]);
      expect(list[1]?.corrects).toEqual([snaps.b, snaps.c]);
      expect(list[0]?.corrects).toBeUndefined();
    });

    it('both views are queries: reading writes nothing, the published snapshots are unchanged', async () => {
      const count = () =>
        Promise.all([
          countOf(fowner, sql`SELECT count(*)::text AS n FROM ranking.snapshot`),
          countOf(fowner, sql`SELECT count(*)::text AS n FROM ranking.run`),
          countOf(fowner, sql`SELECT count(*)::text AS n FROM platform.outbox_event`),
        ]);
      const before = await count();
      const hashes = await sql<{
        h: string;
      }>`SELECT snapshot_hash AS h FROM ranking.snapshot ORDER BY id`.execute(fowner);
      await history.asPublished(systemId);
      await history.asCorrected(systemId);
      await history.read(snaps.e as string);
      expect(await count()).toEqual(before);
      expect(
        (
          await sql<{
            h: string;
          }>`SELECT snapshot_hash AS h FROM ranking.snapshot ORDER BY id`.execute(fowner)
        ).rows,
      ).toEqual(hashes.rows);
    });

    it('read-time STALE: synthetic fixture pins are unknown to the canonical tables ⇒ affected (fail closed)', async () => {
      const r = await history.read(snaps.e as string);
      expect(r.snapshot).toMatchObject({
        snapshotId: snaps.e,
        lineageKind: 'FOLLOWS',
        priorSnapshotId: snaps.d,
      });
      if (r.staleness.state !== 'STALE') throw new Error('fixture pins can never read CURRENT');
      expect(r.staleness.reasons).toEqual([
        'BASIS_RESULT_NOT_CURRENT',
        'BASIS_VERIFICATION_NOT_CURRENT',
      ]);
      expect(r.staleness.affected).toHaveLength(2);
    });

    it('the run dependency index: fixture runs index only their system version', async () => {
      const deps = await history.dependents('SYSTEM_VERSION', systemVersionId);
      expect(deps).toHaveLength(5);
      expect(deps.filter((d) => d.snapshotId !== undefined)).toHaveLength(5);
      expect(await history.dependents('RESULT_VERSION', newId())).toEqual([]);
    });
  });
});
