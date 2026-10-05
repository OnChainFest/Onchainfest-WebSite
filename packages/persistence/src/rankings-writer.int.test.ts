import { newId, type AuthorityScope, type Uuid } from '@br/domain';
import {
  hashClassificationDerivationInput,
  hashRankingRunInput,
  evaluateRankingRun,
  validateRankingSnapshot,
} from '@br/rankings';
import {
  FIXTURE_FACT_KINDS,
  rankCandidate,
  rankingRunInput,
  rankingSpec,
} from '@br/rankings/fixtures';
import {
  apiDb,
  awaitDbTimePast,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  newOrganizer,
  newTestAccount,
  operatorDb,
  ownerDb,
  probeDb,
  seedTestCatalog,
  uniqueSlug,
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
import { assembleClassificationInput } from './classification-loader';
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
import { persistRankingRun, publishRankingSnapshot } from './ranking-lanes';
import { assembleRankingRunInput } from './ranking-loader';
import { RankingService } from './ranking-store';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-10 Step 5 — the canonical loader / store / writer layer:
 *
 *   DERIVE → LOAD CANONICAL FACTS → RE-DERIVE → COMPARE → PERSIST
 *
 * The NORMAL schema holds only canonical facts: classifications enter only through the ResultLedger T2
 * (re-derived and compared), definitions only through the operator login, runs only through the
 * validated writer (BLOCKED today: no FINAL / V2 / hold producer). Positive snapshot mechanics run in a
 * THROWAWAY br_rkfx_ overlay database with REFERENCE FIXTURES — NOT SPORTING TRUTH.
 */
const DENIED = { code: '42501' };
const APPEND_ONLY = { code: 'BR001' };
const asRole = <T>(db: Db, role: ModuleRole, fn: (ctx: TxContext) => Promise<T>) =>
  inTransaction(db, role, fn, 1);
const setRole = (db: Db, role: string) =>
  db.transaction().execute((trx) => sql`SET LOCAL ROLE ${sql.id(role)}`.execute(trx));
const k = (p = 'k') => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const randomHash = () => `sha256:${newId().replace(/-/g, '').repeat(2)}`;
const countOf = async (db: Db, q: ReturnType<typeof sql<{ n: string }>>) =>
  Number((await q.execute(db)).rows[0]?.n ?? -1);

/** `@2` content as a test may tamper with it (members optional so they can be deleted). */
interface MutableEntry {
  participantId: string;
  rank: number;
  tied: boolean;
  tieBreakKeys: [{ key: string; order: string; value: string }];
}
interface MutableContent {
  /** The fixture contests have exactly two entrants. */
  entries: [MutableEntry, MutableEntry] | [MutableEntry];
  derivation: {
    derivedFrom: [{ resultVersionId: string; contentHash: string; status: string }];
    policy: { policyId: string; policyVersionId: string; specHash: string };
    disciplineVersionId: string;
    engineVersion: string;
    inputsDigest?: string;
  };
}

const api = apiDb();
const owner = ownerDb();
const probe = probeDb();
const maintenance = maintenanceDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const op = operatorDb();
afterAll(async () => {
  await Promise.all([api, owner, probe, maintenance, rop, rw, op].map((d) => d.destroy()));
});

const identity = new IdentityStore(api);
const authority = new AuthorityStore(api, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(api, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(api);
const definitions = new RankingDefinitionStore(rop);
const rankings = new RankingService(rw);
let catalog: TestCatalog;
let codes: { sport: string; discipline: string };

const scopeOf = async (level: 'CONTEST' | 'ROUND' | 'EVENT' | 'COMPETITION', id: string) =>
  ({ ...(await resolver.scopeOf(level, id)), recognitionLevel: ['PLATFORM'] }) as AuthorityScope;

/** A real contest (timed discipline) + an acceptor holding only ACCEPT_RESULT for its competition. */
async function contestWorld(winnerMs = '10870', loserMs = '11020') {
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
    timed: { winnerMs, loserMs },
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
  const { rows } = await sql<{ round_id: string }>`
    SELECT round_id FROM competition.contest WHERE id = ${w.contestId}`.execute(owner);
  return { ...w, acceptorId: acceptor.id, roundId: rows[0]?.round_id as string };
}

const accept = async (versionId: string, scope: AuthorityScope, actor: string) =>
  ledger.transition({
    resultVersionId: versionId as Uuid,
    toStatus: 'PROVISIONAL',
    actorPrincipalId: actor as Uuid,
    scope,
    idempotencyKey: k('accept'),
  });

async function submit(
  w: { submitterPrincipalId: string },
  resultId: string,
  content: unknown,
  scope: AuthorityScope,
  actor = w.submitterPrincipalId,
  idempotencyKey = k('submit'),
) {
  const { draftId } = await ledger.saveDraft({
    resultId: resultId as Uuid,
    authorPrincipalId: actor as Uuid,
    disciplineVersionRef: 'timed.singles@1',
    content,
  });
  return ledger.submitDraft({
    draftId,
    actorPrincipalId: actor as Uuid,
    scope,
    idempotencyKey,
  });
}

const policySpec = (scopeType: string, displayName = 'Fictional event table') => ({
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

async function publishedPolicy(scopeType: string, displayName?: string) {
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
  return { policyId, ...v };
}

const systemSpec = (o: { effectiveFrom: string; patch?: Record<string, unknown> }) =>
  rankingSpec({
    universe: {
      disciplineVersionId: catalog.timedSingles,
      metric: { key: 'elapsedTimeMs', markMetricId: 'athletics.100m.time' },
      resultScope: 'CONTEST',
      holderType: 'ATHLETE',
      population: {},
    },
    recognition: { level: 'PLATFORM', sport: [codes.sport] },
    effectiveFrom: o.effectiveFrom,
    ...(o.patch ?? {}),
  });

async function definedSystem(
  store: RankingDefinitionStore,
  operatorAccountId: string,
  spec: unknown,
  kind = 'PLATFORM',
) {
  const { systemId } = await store.createRankingSystem({
    operatorAccountId,
    code: `rk-${newId().slice(-12)}`,
    name: 'Fictional best marks',
    kind,
    idempotencyKey: k('rs'),
  });
  const v = await store.createRankingSystemVersion({
    operatorAccountId,
    systemId,
    spec,
    idempotencyKey: k('rsv'),
  });
  return { systemId, ...v };
}

beforeAll(async () => {
  catalog = await seedTestCatalog(identity, new CatalogStore(op));
  const { rows } = await sql<{ sport: string; discipline: string }>`
    SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
    JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
    WHERE v.id = ${catalog.timedSingles}`.execute(owner);
  codes = rows[0] as { sport: string; discipline: string };
}, 120_000);

// ═════════════════════════════ classifications: `@2` only through the ResultLedger T2 ═════════════════════════════

describe('classification @2 through the ResultLedger (re-derive and compare)', () => {
  let w: Awaited<ReturnType<typeof contestWorld>>;
  let eventPolicy: Awaited<ReturnType<typeof publishedPolicy>>;
  let contestScope: AuthorityScope;
  let eventScope: AuthorityScope;
  let classificationId: Uuid;
  let proposal: { contentHash: string; content: Record<string, unknown> };
  let submitted: Awaited<ReturnType<typeof submit>>;

  beforeAll(async () => {
    eventPolicy = await publishedPolicy('EVENT_CLASSIFICATION');
    await publishedPolicy('COMPETITION_CLASSIFICATION');
    w = await contestWorld();
    contestScope = await scopeOf('CONTEST', w.contestId);
    eventScope = await scopeOf('EVENT', w.eventId);
    await accept(w.resultVersionId, contestScope, w.acceptorId);
    classificationId = (
      await ledger.createResult({
        scopeType: 'EVENT_CLASSIFICATION',
        scopeTargetId: w.eventId as Uuid,
      })
    ).id;
    const p = await ledger.proposeClassification(classificationId);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined)
      throw new Error(`no proposal: ${JSON.stringify(p)}`);
    proposal = p.outcome.proposal as unknown as typeof proposal;
  }, 180_000);

  const tampered = (fn: (c: MutableContent) => void) => {
    const c = structuredClone(proposal.content) as unknown as MutableContent;
    fn(c);
    return c;
  };

  it('15. a principal without SUBMIT_RESULT cannot submit a classification', async () => {
    await expect(
      submit(w, classificationId, proposal.content, eventScope, w.acceptorId),
    ).rejects.toMatchObject({ code: 'AUTHORITY_DENIED' });
  });

  it('9–10. modified ranks, trace values or pins (incl. hashes) are refused: CLASSIFICATION_DERIVATION_MISMATCH', async () => {
    for (const bad of [
      tampered((c) => {
        // Swap the two derived ranks (whatever order the canonical set put the entries in).
        const [a, b = a] = c.entries;
        [a.rank, b.rank] = [b.rank, a.rank];
      }),
      tampered((c) => {
        c.entries[0].tieBreakKeys[0].value = '1';
      }),
      tampered((c) => {
        c.derivation.inputsDigest = randomHash();
      }),
      tampered((c) => {
        c.derivation.derivedFrom[0].contentHash = randomHash();
      }),
      tampered((c) => {
        c.derivation.policy.specHash = randomHash();
      }),
      // A caller-provided rank table "dressed up" with the right pins is still derived, not trusted.
      tampered((c) => {
        c.entries = [c.entries[0]];
      }),
    ])
      await expect(submit(w, classificationId, bad, eventScope)).rejects.toMatchObject({
        code: 'CLASSIFICATION_DERIVATION_MISMATCH',
        details: { reason: 'CONTENT_MISMATCH', canonicalContentHash: proposal.contentHash },
      });
  });

  it('7. malformed @2 content is refused before any draft exists', async () => {
    const { derivation, ...noDerivationEntries } = proposal.content as { derivation: object };
    // saveDraft validates synchronously (as for `@1`): lift the throw into the promise.
    const save = (content: unknown) =>
      Promise.resolve().then(() =>
        ledger.saveDraft({
          resultId: classificationId,
          authorPrincipalId: w.submitterPrincipalId as Uuid,
          disciplineVersionRef: 'timed.singles@1',
          content,
        }),
      );
    await expect(
      save({ ...noDerivationEntries, derivation: { ...derivation, extra: 'x' } }),
    ).rejects.toThrow('BRJ_UNKNOWN_FIELD');
    await expect(
      save(
        tampered((c) => {
          delete c.derivation.inputsDigest;
        }),
      ),
    ).rejects.toThrow();
  });

  it('8. @2 content on a CONTEST Result is refused (a caller cannot label sporting content a classification)', async () => {
    await expect(submit(w, w.resultId, proposal.content, contestScope)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { reason: 'NOT_A_CLASSIFICATION_RESULT' },
    });
  });

  it('52. a refused submission leaves no ResultVersion, derivation or input row', async () => {
    expect(
      await countOf(
        owner,
        sql<{
          n: string;
        }>`SELECT count(*) AS n FROM results.result_version WHERE result_id = ${classificationId}`,
      ),
    ).toBe(0);
    expect(
      await countOf(
        owner,
        sql<{ n: string }>`SELECT count(*) AS n FROM results.classification_derivation d
          JOIN results.result_version v ON v.id = d.result_version_id WHERE v.result_id = ${classificationId}`,
      ),
    ).toBe(0);
  });

  it('1–6. the canonical proposal is accepted at T2 and pinned: scope → policy → DV → exact inputs → content hash', async () => {
    submitted = await submit(w, classificationId, proposal.content, eventScope);
    expect(submitted).toMatchObject({ created: true, status: 'SUBMITTED' });
    expect(submitted.contentHash).toBe(proposal.contentHash);
    const { rows: v } = await sql<{ content_schema: string; content_hash: string }>`
      SELECT content_schema, content_hash FROM results.result_version WHERE id = ${submitted.resultVersionId}`.execute(
      owner,
    );
    expect(v[0]).toEqual({
      content_schema: 'br:result-version-content@2',
      content_hash: proposal.contentHash,
    });
    const { rows: d } = await sql<Record<string, unknown>>`
      SELECT policy_id, policy_version_id, policy_spec_hash, discipline_version_id, engine_version,
             inputs_digest, input_count FROM results.classification_derivation
      WHERE result_version_id = ${submitted.resultVersionId}`.execute(owner);
    // The pinned inputs digest is the hash of the canonical re-assembly: scope (event + its contests),
    // the policy version + spec, the DisciplineVersion + spec hash, every exact input version.
    const assembly = await inTransaction(api, ModuleRole.results, (ctx) =>
      assembleClassificationInput(ctx, classificationId),
    );
    if (!assembly.ok) throw new Error(assembly.reason);
    const digest = hashClassificationDerivationInput(assembly.input);
    if (!digest.ok) throw new Error('digest');
    expect(assembly.input.scope).toEqual({
      scopeType: 'EVENT_CLASSIFICATION',
      scopeId: w.eventId,
      contestIds: [w.contestId],
    });
    expect(d[0]).toEqual({
      policy_id: eventPolicy.policyId,
      policy_version_id: eventPolicy.policyVersionId,
      policy_spec_hash: eventPolicy.specHash,
      discipline_version_id: catalog.timedSingles,
      engine_version: 'classification-engine/1',
      inputs_digest: digest.hash,
      input_count: 1,
    });
    const { rows: dv } = await sql<{ spec_hash: string }>`
      SELECT spec_hash FROM sports.discipline_version WHERE id = ${catalog.timedSingles}`.execute(
      owner,
    );
    expect(assembly.input.discipline.specHash).toBe(dv[0]?.spec_hash);
    const { rows: inputs } = await sql<{ id: string; hash: string; status: string }>`
      SELECT input_result_version_id::text AS id, input_content_hash AS hash, input_status AS status
      FROM results.classification_input WHERE classification_version_id = ${submitted.resultVersionId}`.execute(
      owner,
    );
    expect(inputs).toEqual([{ id: w.resultVersionId, hash: w.contentHash, status: 'PROVISIONAL' }]);
    // Ranks were derived (winner faster), never trusted.
    const entries = (proposal.content as { entries: { participantId: string; rank: number }[] })
      .entries;
    const [winner, loser] = w.participantIds as [string, string];
    expect(Object.fromEntries(entries.map((e) => [e.participantId, e.rank]))).toEqual({
      [winner]: 1,
      [loser]: 2,
    });
  });

  it('49. the normal ResultSubmitted outbox event carries the classification pins', async () => {
    const { rows } = await sql<{ payload: Record<string, unknown> }>`
      SELECT payload FROM platform.outbox_event
      WHERE event_type = 'ResultSubmitted' AND aggregate_id = ${submitted.resultVersionId}`.execute(
      owner,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toMatchObject({
      contentSchema: 'br:result-version-content@2',
      classification: { policyVersionId: eventPolicy.policyVersionId, inputCount: 1 },
    });
  });

  it('13 & 50. a retried / repeated identical submission is idempotent (no second version, no second event)', async () => {
    // A new draft with identical content resolves to the existing version.
    const again = await submit(w, classificationId, proposal.content, eventScope);
    expect(again).toMatchObject({
      resultVersionId: submitted.resultVersionId,
      created: false,
    });
    // A retried command (same draft + idempotency key) replays the stored response.
    const { draftId } = await ledger.saveDraft({
      resultId: classificationId,
      authorPrincipalId: w.submitterPrincipalId as Uuid,
      disciplineVersionRef: 'timed.singles@1',
      content: proposal.content,
    });
    const cmd = {
      draftId,
      actorPrincipalId: w.submitterPrincipalId as Uuid,
      scope: eventScope,
      idempotencyKey: k('retry'),
    };
    const [r1, r2] = [await ledger.submitDraft(cmd), await ledger.submitDraft(cmd)];
    expect(r1.resultVersionId).toBe(submitted.resultVersionId);
    expect(r2).toMatchObject({ resultVersionId: submitted.resultVersionId, created: false });
    expect(
      await countOf(
        owner,
        sql<{
          n: string;
        }>`SELECT count(*) AS n FROM results.result_version WHERE result_id = ${classificationId}`,
      ),
    ).toBe(1);
    expect(
      await countOf(
        owner,
        sql<{ n: string }>`SELECT count(*) AS n FROM platform.outbox_event
          WHERE event_type = 'ResultSubmitted' AND aggregate_id = ${submitted.resultVersionId}`,
      ),
    ).toBe(1);
  });

  it('16. T3 still requires ACCEPT_RESULT (a SUBMIT_RESULT holder cannot accept)', async () => {
    await expect(
      accept(submitted.resultVersionId, eventScope, w.submitterPrincipalId),
    ).rejects.toMatchObject({ code: 'AUTHORITY_DENIED' });
    const t = await accept(submitted.resultVersionId, eventScope, w.acceptorId);
    expect(t.status).toBe('PROVISIONAL');
  });

  it('a current classification is never replaced (no T7 producer): CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION', async () => {
    // The canonical derivation is unchanged ⇒ the identical content is a duplicate, not a replacement.
    const same = await submit(w, classificationId, proposal.content, eventScope);
    expect(same.created).toBe(false);
    // A new policy version changes the canonical derivation, but the current version stays current.
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId: eventPolicy.policyVersionId,
      status: 'RETIRED',
    });
    await publishedPolicy('EVENT_CLASSIFICATION', 'Fictional event table two');
    const p = await ledger.proposeClassification(classificationId);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined) throw new Error('no proposal');
    expect(p.outcome.proposal.contentHash).not.toBe(proposal.contentHash);
    await expect(
      submit(w, classificationId, p.outcome.proposal.content, eventScope),
    ).rejects.toMatchObject({
      code: 'CURRENT_VERSION_CONFLICT',
      details: {
        reason: 'CLASSIFICATION_REPLACEMENT_REQUIRES_CORRECTION',
        currentVersionId: submitted.resultVersionId,
      },
    });
  });

  it('12. a stale / non-current input (a REJECTED version) cannot be pinned', async () => {
    const v2 = await w.submitNextVersion();
    await ledger.transition({
      resultVersionId: v2.resultVersionId,
      toStatus: 'REJECTED',
      actorPrincipalId: w.acceptorId as Uuid,
      scope: contestScope,
      idempotencyKey: k('reject'),
      reason: 'fixture: duplicate sheet',
    });
    const compResult = await ledger.createResult({
      scopeType: 'COMPETITION_CLASSIFICATION',
      scopeTargetId: w.competitionId as Uuid,
    });
    const p = await ledger.proposeClassification(compResult.id);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined) throw new Error('no proposal');
    const stale = structuredClone(p.outcome.proposal.content) as unknown as MutableContent;
    stale.derivation.derivedFrom = [
      { resultVersionId: v2.resultVersionId, contentHash: v2.contentHash, status: 'PROVISIONAL' },
    ];
    await expect(
      submit(w, compResult.id, stale, await scopeOf('COMPETITION', w.competitionId)),
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DERIVATION_MISMATCH' });
  });

  it('14. concurrent identical submissions produce ONE authoritative version', async () => {
    const compResult = await ledger.createResult({
      scopeType: 'COMPETITION_CLASSIFICATION',
      scopeTargetId: w.competitionId as Uuid,
    });
    const p = await ledger.proposeClassification(compResult.id);
    if (p.state !== 'PROPOSED' || p.outcome.proposal === undefined) throw new Error('no proposal');
    const scope = await scopeOf('COMPETITION', w.competitionId);
    const outs = await Promise.all(
      [1, 2, 3, 4].map(() => submit(w, compResult.id, p.outcome.proposal?.content, scope)),
    );
    expect(new Set(outs.map((o) => o.resultVersionId)).size).toBe(1);
    expect(outs.filter((o) => o.created)).toHaveLength(1);
    expect(
      await countOf(
        owner,
        sql<{ n: string }>`SELECT count(*) AS n FROM results.classification_derivation d
          JOIN results.result_version v ON v.id = d.result_version_id WHERE v.result_id = ${compResult.id}`,
      ),
    ).toBe(1);
  });

  it('11. a contest without a current input blocks the derivation: CLASSIFICATION_INPUT_MISSING', async () => {
    const w2 = await contestWorld('10900', '11100'); // SUBMITTED only (never accepted)
    const r = await ledger.createResult({
      scopeType: 'EVENT_CLASSIFICATION',
      scopeTargetId: w2.eventId as Uuid,
    });
    const p = await ledger.proposeClassification(r.id);
    expect(p).toMatchObject({ state: 'BLOCKED' });
    expect(p.state === 'BLOCKED' && p.outcome.blockers).toEqual(['CLASSIFICATION_INPUT_MISSING']);
    await expect(
      submit(w2, r.id, proposal.content, await scopeOf('EVENT', w2.eventId)),
    ).rejects.toMatchObject({
      code: 'CLASSIFICATION_DERIVATION_MISMATCH',
      details: { reason: 'DERIVATION_BLOCKED', blockers: ['CLASSIFICATION_INPUT_MISSING'] },
    });
  });

  it('policy binding is unique-or-fail: none ⇒ POLICY_UNAVAILABLE; two ⇒ CLASSIFICATION_POLICY_AMBIGUOUS', async () => {
    const r = await ledger.createResult({
      scopeType: 'ROUND_CLASSIFICATION',
      scopeTargetId: w.roundId as Uuid,
    });
    expect(await ledger.proposeClassification(r.id)).toEqual({
      state: 'UNAVAILABLE',
      reason: 'POLICY_UNAVAILABLE',
    });
    await publishedPolicy('ROUND_CLASSIFICATION', 'Fictional heats one');
    expect((await ledger.proposeClassification(r.id)).state).toBe('PROPOSED');
    const second = await publishedPolicy('ROUND_CLASSIFICATION', 'Fictional heats two');
    expect(await ledger.proposeClassification(r.id)).toEqual({
      state: 'UNAVAILABLE',
      reason: 'CLASSIFICATION_POLICY_AMBIGUOUS',
    });
    await expect(
      submit(w, r.id, proposal.content, await scopeOf('ROUND', w.roundId)),
    ).rejects.toMatchObject({
      code: 'CLASSIFICATION_DERIVATION_MISMATCH',
      details: { reason: 'CLASSIFICATION_POLICY_AMBIGUOUS' },
    });
    // Retiring one restores a unique binding — no precedence rule is ever applied.
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId: second.policyVersionId,
      status: 'RETIRED',
    });
    expect((await ledger.proposeClassification(r.id)).state).toBe('PROPOSED');
  });

  it('a COMPETITION whose events have different DisciplineVersions fails closed (no silent filter)', async () => {
    const org = await newOrganizer(identity, new OrganizationStore(api));
    const comps = new CompetitionStore(api);
    const { competitionId } = await comps.createCompetition({
      actorAccountId: org.ownerAccountId,
      organizerOrganizationId: org.organizationId,
      slug: uniqueSlug('mix'),
      profile: { name: 'Fictional Mixed Open', timezone: 'UTC' },
      idempotencyKey: k('c'),
    });
    await comps.publishCompetition({ actorAccountId: org.ownerAccountId, competitionId });
    for (const dv of [catalog.timedSingles, catalog.tennisSingles])
      await comps.createEvent({
        actorAccountId: org.ownerAccountId,
        competitionId,
        slug: uniqueSlug('mixe'),
        disciplineVersionId: dv,
        formatVersionId: catalog.singleElimination,
        settings: { name: 'Fictional Singles' },
        idempotencyKey: k('e'),
      });
    const r = await ledger.createResult({
      scopeType: 'COMPETITION_CLASSIFICATION',
      scopeTargetId: competitionId as Uuid,
    });
    const a = await inTransaction(api, ModuleRole.results, (ctx) =>
      assembleClassificationInput(ctx, r.id),
    );
    expect(a).toMatchObject({ ok: false, reason: 'DISCIPLINE_VERSION_MISMATCH' });
  });
});

// ═════════════════════════════ ranking definitions (br_ranking_operator_app → br_ranking_rules) ═════════════════════════════

describe('ranking system definitions: immutable versions, lifecycle, owner binding, no backdating', () => {
  let platform: Awaited<ReturnType<typeof definedSystem>>;

  it('17. a valid PLATFORM system / version is created, published and audited', async () => {
    platform = await definedSystem(
      definitions,
      catalog.operatorAccountId,
      systemSpec({ effectiveFrom: futureIso(4) }),
    );
    const pub = await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: platform.systemVersionId,
      status: 'PUBLISHED',
    });
    expect(pub).toMatchObject({ status: 'PUBLISHED', changed: true });
    const { rows } = await sql<{ e: string }>`
      SELECT event_type AS e FROM platform.outbox_event
      WHERE aggregate_id IN (${platform.systemId}, ${platform.systemVersionId}) ORDER BY recorded_at, event_type`.execute(
      owner,
    );
    expect(rows.map((r) => r.e).sort()).toEqual([
      'RankingSystemCreated',
      'RankingSystemVersionCreated',
      'RankingSystemVersionPublished',
    ]);
    const { rows: audit } = await sql<{ a: string }>`
      SELECT action AS a FROM platform.audit_event
      WHERE target_id IN (${platform.systemId}, ${platform.systemVersionId}) ORDER BY action`.execute(
      owner,
    );
    expect(audit.map((r) => r.a)).toEqual([
      'ranking.system-created',
      'ranking.system-version-created',
      'ranking.system-version-published',
    ]);
  });

  it('18. a published version is immutable (no UPDATE / DELETE, even for the owner; same spec = no new version)', async () => {
    await expect(
      sql`UPDATE ranking.system_version SET spec = '{}'::jsonb WHERE id = ${platform.systemVersionId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
    await expect(
      sql`DELETE FROM ranking.system_version_status_change WHERE system_version_id = ${platform.systemVersionId}`.execute(
        owner,
      ),
    ).rejects.toMatchObject(APPEND_ONLY);
    const { rows } = await sql<{ spec: unknown }>`
      SELECT spec FROM ranking.system_version WHERE id = ${platform.systemVersionId}`.execute(
      owner,
    );
    // The same spec never becomes a second version (and its effectiveFrom may have passed already).
    await expect(
      definitions.createRankingSystemVersion({
        operatorAccountId: catalog.operatorAccountId,
        systemId: platform.systemId,
        spec: rows[0]?.spec,
        idempotencyKey: k('dup'),
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^(ALREADY_EXISTS|BACKDATING_REJECTED)$/),
    });
  });

  it('19. lifecycle is DRAFT → PUBLISHED → RETIRED only (append-only facts)', async () => {
    const s = await definedSystem(
      definitions,
      catalog.operatorAccountId,
      systemSpec({ effectiveFrom: futureIso(60) }),
    );
    await expect(
      definitions.changeRankingSystemVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        systemVersionId: s.systemVersionId,
        status: 'RETIRED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    for (const status of ['PUBLISHED', 'RETIRED'] as const)
      await definitions.changeRankingSystemVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        systemVersionId: s.systemVersionId,
        status,
      });
    await expect(
      definitions.changeRankingSystemVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        systemVersionId: s.systemVersionId,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('20–21. OFFICIAL owner binding is validated against a CURRENT anchor; a fake / uncovered owner is refused', async () => {
    const org = await authority.registerPrincipal({
      principalType: 'ORGANIZATION',
      label: 'fictional federation (fixture)',
    });
    const { anchorId } = await authority.recognizeTrustAnchor({
      principalId: org.id,
      recognitionScope: { recognitionLevel: ['NATIONAL'], sport: [codes.sport], region: ['CR'] },
      basisRef: 'fixture',
      governanceDecisionRef: k('gov'),
    });
    const official = (ownerPatch: object, recognition: object = {}) =>
      systemSpec({
        effectiveFrom: futureIso(60),
        patch: {
          displayName: 'Fictional association marks',
          kind: 'OFFICIAL',
          requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
          recognition: { level: 'NATIONAL', sport: [codes.sport], region: ['CR'], ...recognition },
          owner: { principalId: org.id, anchorId, ...ownerPatch },
        },
      });
    const ok = await definedSystem(
      definitions,
      catalog.operatorAccountId,
      official({}),
      'OFFICIAL',
    );
    expect(ok.created).toBe(true);
    const issueOf = async (spec: unknown) =>
      definedSystem(definitions, catalog.operatorAccountId, spec, 'OFFICIAL').then(
        () => 'ACCEPTED',
        (e: { details?: { issues?: { code: string }[] } }) => e.details?.issues?.[0]?.code,
      );
    expect(await issueOf(official({ anchorId: newId() }))).toBe('OWNER_ANCHOR_UNKNOWN');
    expect(await issueOf(official({ principalId: newId() }))).toBe('OWNER_ANCHOR_MISMATCH');
    expect(await issueOf(official({}, { region: ['PA'] }))).toBe('OWNER_RECOGNITION_NOT_COVERED');
    expect(await issueOf(official({}, { level: 'WORLD', region: undefined }))).toBe(
      'OWNER_RECOGNITION_NOT_COVERED',
    );
    // The platform never masquerades as an owner, and a free-text name never claims recognition.
    expect(
      await issueOf(
        systemSpec({
          effectiveFrom: futureIso(60),
          patch: { owner: { principalId: org.id, anchorId } },
        }),
      ),
    ).toBe('OWNER_NOT_ALLOWED_FOR_PLATFORM');
    await expect(
      definitions.createRankingSystem({
        operatorAccountId: catalog.operatorAccountId,
        code: `rk-${newId().slice(-12)}`,
        name: 'Official national ranking',
        kind: 'OFFICIAL',
        idempotencyKey: k('n'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('22. a backdated definition is refused (creation and publication)', async () => {
    await expect(
      definedSystem(
        definitions,
        catalog.operatorAccountId,
        systemSpec({ effectiveFrom: '2020-01-01T00:00:00.000Z' }),
      ),
    ).rejects.toMatchObject({ code: 'BACKDATING_REJECTED' });
    const eff = futureIso(2);
    const s = await definedSystem(
      definitions,
      catalog.operatorAccountId,
      systemSpec({ effectiveFrom: eff }),
    );
    await awaitDbTimePast(api, eff);
    await expect(
      definitions.changeRankingSystemVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        systemVersionId: s.systemVersionId,
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({ code: 'BACKDATING_REJECTED' });
  });
});

// ═════════════════════════════ canonical ranking runs (br_ranking_worker_app → br_rankings) ═════════════════════════════

// ═════════════════════════════ Step 15: definitions against the real catalog; command idempotency ═════════════════════════════

describe('Step 15 — definitions are validated against the exact catalog facts; commands are idempotent', () => {
  /** Every row, event and audit entry a ranking-system definition command can write. */
  const definitionFootprint = async () =>
    (
      await sql<Record<string, number>>`
        SELECT (SELECT count(*) FROM ranking.system)::int AS systems,
               (SELECT count(*) FROM ranking.system_version)::int AS versions,
               (SELECT count(*) FROM ranking.system_version_status_change)::int AS transitions,
               (SELECT count(*) FROM ranking_read.system_card)::int AS cards,
               (SELECT count(*) FROM platform.outbox_event WHERE event_type LIKE 'RankingSystem%')::int AS events,
               (SELECT count(*) FROM platform.audit_event WHERE action LIKE 'ranking.system%')::int AS audits,
               (SELECT count(*) FROM platform.command_idempotency
                 WHERE command_type LIKE 'Create%Ranking%')::int AS commands`.execute(owner)
    ).rows[0];
  const refusedWith = (p: Promise<unknown>, code: string) =>
    expect(p).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { issues: expect.arrayContaining([expect.objectContaining({ code })]) },
    });

  it('a spec is refused against the REAL DisciplineVersion / competition facts, and a refusal writes nothing', async () => {
    const { systemId } = await definitions.createRankingSystem({
      operatorAccountId: catalog.operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    });
    // A DRAFT DisciplineVersion of the same sport (never published).
    const { rows } = await sql<{ sport_id: string }>`
      SELECT d.sport_id::text FROM sports.discipline_version v JOIN sports.discipline d ON d.id = v.discipline_id
      WHERE v.id = ${catalog.timedSingles}`.execute(owner);
    const catalogStore = new CatalogStore(op);
    const { disciplineId } = await catalogStore.createDiscipline({
      operatorAccountId: catalog.operatorAccountId,
      sportId: rows[0]?.sport_id as string,
      code: `${codes.sport}.draft${newId().replace(/-/g, '').slice(-8)}`,
      name: 'Fictional draft discipline',
      idempotencyKey: k('disc'),
    });
    const { rows: dvSpec } = await sql<{ spec: unknown }>`
      SELECT spec FROM sports.discipline_version WHERE id = ${catalog.timedSingles}`.execute(owner);
    const { disciplineVersionId: draftDv } = await catalogStore.createDisciplineVersion({
      operatorAccountId: catalog.operatorAccountId,
      disciplineId,
      spec: dvSpec[0]?.spec as Parameters<CatalogStore['createDisciplineVersion']>[0]['spec'],
      idempotencyKey: k('dv'),
    });

    const base = systemSpec({ effectiveFrom: futureIso(120) }) as {
      universe: Record<string, unknown> & { metric: Record<string, unknown> };
      comparator: { keys: Record<string, unknown>[] };
    };
    const variant = (o: {
      universe?: Record<string, unknown>;
      metric?: Record<string, unknown>;
      key?: Record<string, unknown>;
      displayName?: string;
    }) => ({
      ...base,
      ...(o.displayName === undefined ? {} : { displayName: o.displayName }),
      universe: {
        ...base.universe,
        ...(o.universe ?? {}),
        metric: { ...base.universe.metric, ...(o.metric ?? {}) },
      },
      comparator: { keys: [{ ...base.comparator.keys[0], ...(o.key ?? {}) }] },
    });
    const version = (spec: unknown) =>
      definitions.createRankingSystemVersion({
        operatorAccountId: catalog.operatorAccountId,
        systemId,
        spec,
        idempotencyKey: k('rsv'),
      });

    const before = await definitionFootprint();
    await refusedWith(
      version(variant({ universe: { disciplineVersionId: newId() } })),
      'DISCIPLINE_VERSION_UNKNOWN',
    );
    await refusedWith(
      version(variant({ universe: { disciplineVersionId: draftDv } })),
      'DISCIPLINE_VERSION_NOT_PUBLISHED',
    );
    await refusedWith(
      version(variant({ key: { order: 'HIGHER_IS_BETTER' } })),
      'COMPARATOR_MISMATCH',
    );
    await refusedWith(
      version(variant({ metric: { key: 'distanceM' }, key: { metric: 'distanceM' } })),
      'METRIC_UNKNOWN',
    );
    await refusedWith(
      version(variant({ universe: { competitionIds: [newId()] } })),
      'COMPETITION_UNKNOWN',
    );
    await refusedWith(
      version(variant({ displayName: 'Fictional national best marks' })),
      'DISPLAY_NAME_CLAIMS_RECOGNITION',
    );
    // The free-text system name obeys the same rule (refused before any transaction).
    await refusedWith(
      definitions.createRankingSystem({
        operatorAccountId: catalog.operatorAccountId,
        code: `rk-${newId().slice(-12)}`,
        name: 'Fictional Official Rankings',
        kind: 'PLATFORM',
        idempotencyKey: k('rs'),
      }),
      'DISPLAY_NAME_CLAIMS_RECOGNITION',
    );
    // No row, projection, event, audit entry or idempotency record was written by any refusal.
    expect(await definitionFootprint()).toEqual(before);
    // The control: the unmodified spec is accepted against the same facts.
    await expect(version(base)).resolves.toMatchObject({ version: 1, created: true });
  });

  it('command idempotency: a replay returns the first response and writes nothing; a reused key is refused', async () => {
    const code = `rk-${newId().slice(-12)}`;
    const cmd = {
      operatorAccountId: catalog.operatorAccountId,
      code,
      name: 'Fictional best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    };
    const first = await definitions.createRankingSystem(cmd);
    expect(first.created).toBe(true);
    const spec = systemSpec({ effectiveFrom: futureIso(120) });
    const vcmd = {
      operatorAccountId: catalog.operatorAccountId,
      systemId: first.systemId,
      spec,
      idempotencyKey: k('rsv'),
    };
    const v1 = await definitions.createRankingSystemVersion(vcmd);
    const publish = {
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: v1.systemVersionId,
      status: 'PUBLISHED' as const,
    };
    await expect(definitions.changeRankingSystemVersionStatus(publish)).resolves.toMatchObject({
      changed: true,
    });
    const after = await definitionFootprint();

    expect(await definitions.createRankingSystem(cmd)).toEqual({
      systemId: first.systemId,
      created: false,
    });
    expect(await definitions.createRankingSystemVersion(vcmd)).toEqual({ ...v1, created: false });
    await expect(definitions.changeRankingSystemVersionStatus(publish)).resolves.toMatchObject({
      status: 'PUBLISHED',
      changed: false,
    });
    expect(await definitionFootprint()).toEqual(after);

    // The same key for a different request is refused, never replayed and never executed.
    await expect(
      definitions.createRankingSystem({ ...cmd, name: 'Fictional best marks two' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await expect(
      definitions.createRankingSystemVersion({
        ...vcmd,
        spec: systemSpec({ effectiveFrom: futureIso(180) }),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await definitionFootprint()).toEqual(after);
  });

  it('concurrent identical commands produce exactly one system and one version', async () => {
    const before = await definitionFootprint();
    const cmd = {
      operatorAccountId: catalog.operatorAccountId,
      code: `rk-${newId().slice(-12)}`,
      name: 'Fictional best marks',
      kind: 'PLATFORM',
      idempotencyKey: k('rs'),
    };
    const systems = await Promise.all(
      [1, 2, 3, 4, 5].map(() => definitions.createRankingSystem(cmd)),
    );
    expect(new Set(systems.map((r) => r.systemId)).size).toBe(1);
    expect(systems.filter((r) => r.created)).toHaveLength(1);
    const systemId = systems[0]?.systemId as string;
    const vcmd = {
      operatorAccountId: catalog.operatorAccountId,
      systemId,
      spec: systemSpec({ effectiveFrom: futureIso(120) }),
      idempotencyKey: k('rsv'),
    };
    const versions = await Promise.all(
      [1, 2, 3, 4, 5].map(() => definitions.createRankingSystemVersion(vcmd)),
    );
    expect(new Set(versions.map((r) => r.systemVersionId)).size).toBe(1);
    expect(versions.filter((r) => r.created)).toHaveLength(1);
    expect(
      await countOf(
        owner,
        sql`SELECT count(*)::text AS n FROM ranking.system_version WHERE system_id = ${systemId}`,
      ),
    ).toBe(1);
    // One system, one version, their two events and two audit rows, two command records.
    const after = await definitionFootprint();
    expect(after).toEqual({
      ...before,
      systems: (before?.systems ?? 0) + 1,
      versions: (before?.versions ?? 0) + 1,
      cards: (before?.cards ?? 0) + 1,
      events: (before?.events ?? 0) + 2,
      audits: (before?.audits ?? 0) + 2,
      commands: (before?.commands ?? 0) + 2,
    });
  });
});

describe('canonical ranking runs: re-assembled, re-evaluated, persisted (BLOCKED in production)', () => {
  let systemVersionId: string;
  let asOf: Date;
  let first: Awaited<ReturnType<RankingService['evaluate']>>;

  beforeAll(async () => {
    const eff = futureIso(3);
    const s = await definedSystem(
      definitions,
      catalog.operatorAccountId,
      systemSpec({ effectiveFrom: eff }),
    );
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: s.systemVersionId,
      status: 'PUBLISHED',
    });
    systemVersionId = s.systemVersionId;
    await contestWorld('10500', '10600'); // more canonical candidates (SUBMITTED only)
    await awaitDbTimePast(api, eff);
    asOf = new Date(Date.now() - 1000);
  }, 180_000);

  it('23–25 & 29. a canonical run is persisted with the exact input digest, outcome and blockers', async () => {
    first = await rankings.evaluate({ systemVersionId, asOf, trigger: 'STAFF_REQUEST' });
    expect(first).toMatchObject({
      created: true,
      provenance: 'CANONICAL_ASSEMBLY',
      publicationState: 'BLOCKED',
      publicationReasons: ['NO_RANKED_ENTRIES'],
      entryCount: 0,
    });
    expect(first.candidateCount).toBeGreaterThanOrEqual(4);
    const input = await inTransaction(rw, ModuleRole.rankings, (ctx) =>
      assembleRankingRunInput(ctx, { systemVersionId, asOf }),
    );
    const h = hashRankingRunInput(input);
    if (!h.ok) throw new Error('input');
    const ev = evaluateRankingRun(input);
    if (!ev.ok) throw new Error('eval');
    const { rows } = await sql<{
      input_hash: string;
      outcome_hash: string;
      outcome: { candidates: { reasons: string[] }[] };
      engine_version: string;
      as_of: Date;
      trigger: string;
      publication_reasons: string[];
    }>`SELECT input_hash, outcome_hash, outcome, engine_version, as_of, trigger, publication_reasons
       FROM ranking.run WHERE id = ${first.runId}`.execute(owner);
    const r = rows[0];
    expect(r?.input_hash).toBe(h.hash);
    expect(r?.outcome_hash).toBe(ev.outcomeHash);
    expect(r?.engine_version).toBe('ranking-engine/1');
    expect(r?.as_of.toISOString()).toBe(asOf.toISOString());
    expect(r?.trigger).toBe('STAFF_REQUEST');
    expect(r?.publication_reasons).toEqual(['NO_RANKED_ENTRIES']);
    // Every candidate is accounted for with its exact blockers (never silently dropped).
    expect(r?.outcome.candidates.every((c) => c.reasons.includes('HOLD_STATE_UNAVAILABLE'))).toBe(
      true,
    );
    const { rows: deps } = await sql<{ t: string; n: string }>`
      SELECT dependency_type AS t, count(*)::text AS n FROM ranking.run_dependency WHERE run_id = ${first.runId}
      GROUP BY dependency_type ORDER BY 1`.execute(owner);
    expect(deps.find((d) => d.t === 'SYSTEM_VERSION')?.n).toBe('1');
    expect(Number(deps.find((d) => d.t === 'RESULT_VERSION')?.n)).toBeGreaterThanOrEqual(3);
  });

  it('27 & 30 & 50. the same input is idempotent; the trigger is metadata, never hashed; one event', async () => {
    const again = await rankings.evaluate({ systemVersionId, asOf, trigger: 'SCHEDULED_SWEEP' });
    expect(again).toMatchObject({ runId: first.runId, inputHash: first.inputHash, created: false });
    expect(
      await countOf(
        owner,
        sql<{ n: string }>`SELECT count(*) AS n FROM platform.outbox_event
          WHERE event_type = 'RankingRunEvaluated' AND aggregate_id = ${first.runId}`,
      ),
    ).toBe(1);
  });

  it('28. concurrent evaluations of the same input produce ONE run', async () => {
    const at = new Date(asOf.getTime() + 1);
    const outs = await Promise.all(
      [1, 2, 3, 4].map(() =>
        rankings.evaluate({ systemVersionId, asOf: at, trigger: 'SCHEDULED_SWEEP' }),
      ),
    );
    expect(new Set(outs.map((o) => o.runId)).size).toBe(1);
    expect(outs.filter((o) => o.created)).toHaveLength(1);
    expect(
      await countOf(
        owner,
        sql<{
          n: string;
        }>`SELECT count(*) AS n FROM ranking.run WHERE system_version_id = ${systemVersionId}
          AND as_of = ${at}`,
      ),
    ).toBe(1);
  });

  it('26. a tampered input or outcome is refused (re-derive and compare)', async () => {
    const input = await inTransaction(rw, ModuleRole.rankings, (ctx) =>
      assembleRankingRunInput(ctx, { systemVersionId, asOf }),
    );
    await expect(
      persistRankingRun(rw, {
        input,
        claimed: { outcomeHash: randomHash() },
        trigger: 'STAFF_REQUEST',
      }),
    ).rejects.toMatchObject({
      code: 'RANKING_INTEGRITY_FAILURE',
      details: { reason: 'OUTCOME_NOT_REPRODUCIBLE' },
    });
    const ev = evaluateRankingRun(input);
    if (!ev.ok) throw new Error('eval');
    const fakeOutcome = { ...ev.outcome, publication: { state: 'PUBLISHABLE', reasons: [] } };
    await expect(
      persistRankingRun(rw, { input, claimed: { outcome: fakeOutcome }, trigger: 'STAFF_REQUEST' }),
    ).rejects.toMatchObject({ details: { reason: 'OUTCOME_NOT_REPRODUCIBLE' } });
    // A "canonical" input claiming FINAL / held-absent facts is not the canonical assembly.
    const forged = {
      ...input,
      candidates: input.candidates.map((c) => ({ ...c, status: 'FINAL', hold: { active: false } })),
    };
    await expect(
      persistRankingRun(rw, { input: forged, trigger: 'STAFF_REQUEST' }),
    ).rejects.toMatchObject({ details: { reason: 'CANONICAL_INPUT_MISMATCH' } });
    // The honest canonical input replays the existing run.
    expect(
      (
        await persistRankingRun(rw, {
          input,
          claimed: { outcomeHash: ev.outcomeHash },
          trigger: 'STAFF_REQUEST',
        })
      ).runId,
    ).toBe(first.runId);
  });

  it('a future sporting cutoff and fixture provenance never reach the normal schema', async () => {
    await expect(
      rankings.evaluate({
        systemVersionId,
        asOf: new Date(Date.now() + 3_600_000),
        trigger: 'STAFF_REQUEST',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const input = await inTransaction(rw, ModuleRole.rankings, (ctx) =>
      assembleRankingRunInput(ctx, { systemVersionId, asOf }),
    );
    await expect(
      persistRankingRun(rw, {
        input: { ...input, provenance: 'REFERENCE_FIXTURE' },
        trigger: 'STAFF_REQUEST',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('32. a BLOCKED canonical run cannot publish a snapshot', async () => {
    await expect(rankings.publish({ runId: first.runId })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { reason: 'RUN_NOT_PUBLISHABLE', reasons: ['NO_RANKED_ENTRIES'] },
    });
    expect(
      await countOf(owner, sql<{ n: string }>`SELECT count(*) AS n FROM ranking.snapshot`),
    ).toBe(0);
  });
});

// ═════════════════════════════ least privilege (0026 grants) ═════════════════════════════

describe('43–48. least privilege after the writer grants', () => {
  it('br_api reaches no ranking role and cannot write ranking tables; br_results gained read-only structure', async () => {
    for (const role of ['br_rankings', 'br_ranking_rules'])
      await expect(setRole(api, role)).rejects.toMatchObject(DENIED);
    for (const stmt of [
      `INSERT INTO ranking.run (id) VALUES ('${newId()}')`,
      `INSERT INTO ranking.system (id) VALUES ('${newId()}')`,
      `UPDATE competition.contest SET sequence = 1`,
      `UPDATE sports.discipline_version SET version = 1`,
    ])
      await expect(
        asRole(api, ModuleRole.results, (ctx) => sql.raw(stmt).execute(ctx.trx)),
      ).rejects.toMatchObject(DENIED);
    // Column grants only: no accounts / names / schedules / settings.
    await expect(
      asRole(api, ModuleRole.results, (ctx) =>
        sql`SELECT created_by_account_id FROM competition.event LIMIT 1`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
  });

  it('44–45. br_ranking_rules cannot write runs / snapshots; br_rankings cannot write definitions or canonical facts', async () => {
    for (const t of ['run', 'run_dependency', 'snapshot', 'snapshot_entry'])
      await expect(
        asRole(rop, ModuleRole.rankingRules, (ctx) =>
          sql`INSERT INTO ${sql.raw(`ranking.${t}`)} DEFAULT VALUES`.execute(ctx.trx),
        ),
      ).rejects.toMatchObject(DENIED);
    for (const stmt of [
      `INSERT INTO ranking.system (id) VALUES ('${newId()}')`,
      `INSERT INTO ranking.classification_policy_version_status_change (id) VALUES ('${newId()}')`,
      `INSERT INTO results.classification_derivation (result_version_id) VALUES ('${newId()}')`,
      `INSERT INTO competition.participant (id) VALUES ('${newId()}')`,
      `INSERT INTO platform.ledger_entry (id) VALUES ('${newId()}')`,
      `UPDATE platform.outbox_event SET event_version = 1`,
    ])
      await expect(
        asRole(rw, ModuleRole.rankings, (ctx) => sql.raw(stmt).execute(ctx.trx)),
      ).rejects.toMatchObject(DENIED);
  });

  it('46–47. rebuild stays read-only; PUBLIC holds nothing; no SECURITY DEFINER was added', async () => {
    await expect(
      asRole(maintenance, ModuleRole.rebuild, (ctx) =>
        sql`INSERT INTO ranking.run (id) VALUES (${newId()})`.execute(ctx.trx),
      ),
    ).rejects.toMatchObject(DENIED);
    const { rows } = await sql<{ t: string }>`
      SELECT grantee || ' ' || table_schema || '.' || table_name || ':' || privilege_type AS t
      FROM information_schema.role_table_grants
      WHERE grantee IN ('br_rankings', 'br_ranking_rules') AND table_schema = 'platform'`.execute(
      owner,
    );
    expect(rows.map((r) => r.t).sort()).toEqual([
      'br_ranking_rules platform.audit_event:INSERT',
      'br_ranking_rules platform.command_idempotency:INSERT',
      'br_ranking_rules platform.command_idempotency:SELECT',
      'br_ranking_rules platform.outbox_event:INSERT',
      'br_ranking_rules platform.outbox_event:SELECT',
      'br_rankings platform.audit_event:INSERT',
      'br_rankings platform.outbox_event:INSERT',
      'br_rankings platform.outbox_event:SELECT',
    ]);
    const { rows: pub } = await sql<{ t: string }>`
      SELECT table_schema || '.' || table_name AS t FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND table_schema IN ('ranking', 'results', 'platform')`.execute(
      owner,
    );
    expect(pub).toEqual([]);
    for (const stmt of ['SELECT 1 FROM ranking.run', 'SELECT 1 FROM results.classification_input'])
      await expect(sql.raw(stmt).execute(probe)).rejects.toMatchObject(DENIED);
  });

  it('48. the BRT-10 logins have exactly their module roles (no unexpected membership)', async () => {
    const { rows } = await sql<{ login: string; role: string; inh: boolean; setr: boolean }>`
      SELECT m.rolname AS login, r.rolname AS role, a.inherit_option AS inh, a.set_option AS setr
      FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member
      WHERE m.rolname IN ('br_ranking_operator_app', 'br_ranking_worker_app')
         OR r.rolname IN ('br_rankings', 'br_ranking_rules')`.execute(owner);
    const key = (x: { login: string; role: string }) => `${x.login}>${x.role}`;
    expect(rows.sort((a, b) => (key(a) < key(b) ? -1 : 1))).toEqual([
      { login: 'br_ranking_operator_app', role: 'br_ranking_rules', inh: false, setr: true },
      { login: 'br_ranking_worker_app', role: 'br_rankings', inh: false, setr: true },
      { login: 'br_ranking_worker_app', role: 'br_verification_reader', inh: false, setr: true },
    ]);
  });
});

// ═════════════════════════════ throwaway fixture database: positive snapshot persistence ═════════════════════════════

describe('REFERENCE FIXTURE lane (br_rkfx_*): snapshot publication through the validated writer', () => {
  let fx: RankingFixtureDatabase;
  const fdbs: Db[] = [];
  let fop: RankingDefinitionStore;
  let fw: Db;
  let fowner: Db;
  let fapi: Db;
  let operatorAccountId: string;
  let dv: string;
  let fcodes: { sport: string; discipline: string };

  beforeAll(async () => {
    fx = await createRankingFixtureDatabase();
    const urls = databaseUrls(fx.database);
    const mk = (u: string | undefined) => {
      const d = createDb(u as string, { max: 3 });
      fdbs.push(d);
      return d;
    };
    fapi = mk(urls.api);
    fowner = mk(urls.owner);
    fw = mk(rankingWorkerDatabaseUrl(fx.database));
    fop = new RankingDefinitionStore(mk(rankingOperatorDatabaseUrl(fx.database)));
    const fidentity = new IdentityStore(fapi);
    const fcat = await seedTestCatalog(
      fidentity,
      new CatalogStore(mk(operatorDatabaseUrl(fx.database))),
    );
    operatorAccountId = (await newTestAccount(fidentity, { withPerson: false, label: 'rk-op' }))
      .accountId;
    dv = fcat.running5k;
    const { rows } = await sql<{ sport: string; discipline: string }>`
      SELECT s.code AS sport, d.code AS discipline FROM sports.discipline_version v
      JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
      WHERE v.id = ${dv}`.execute(fowner);
    fcodes = rows[0] as { sport: string; discipline: string };
  }, 240_000);
  afterAll(async () => {
    await Promise.all(fdbs.map((d) => d.destroy()));
    await fx.destroy();
  }, 60_000);

  const T = () => ({ eff: futureIso(3) });
  const spec = (effectiveFrom: string, patch: Record<string, unknown> = {}) =>
    rankingSpec({
      universe: {
        disciplineVersionId: dv,
        metric: { key: 'elapsedTimeMs', markMetricId: 'running.elapsed_time' },
        resultScope: 'CONTEST',
        holderType: 'ATHLETE',
        population: {},
      },
      recognition: { level: 'PLATFORM', sport: [fcodes.sport] },
      effectiveFrom,
      ...patch,
    });

  async function fixtureSystem(
    patch: Record<string, unknown> = {},
    kind = 'PLATFORM',
    publish = true,
  ) {
    const { eff } = T();
    const s = await definedSystem(fop, operatorAccountId, spec(eff, patch), kind);
    if (publish)
      await fop.changeRankingSystemVersionStatus({
        operatorAccountId,
        systemVersionId: s.systemVersionId,
        status: 'PUBLISHED',
      });
    const { rows } = await sql<{ spec: Record<string, unknown>; code: string }>`
      SELECT v.spec, s.code FROM ranking.system_version v JOIN ranking.system s ON s.id = v.system_id
      WHERE v.id = ${s.systemVersionId}`.execute(fowner);
    const row = rows[0] as { spec: Record<string, unknown>; code: string };
    const later = (minutes: number) => new Date(Date.parse(eff) + minutes * 60_000).toISOString();
    const input = (candidates: unknown[], extra: Record<string, unknown> = {}, asOfMin = 120) =>
      rankingRunInput(candidates, {
        spec: row.spec,
        system: {
          systemId: s.systemId,
          systemVersionId: s.systemVersionId,
          code: row.code,
          version: s.version,
          specHash: s.specHash,
          lifecycle: publish ? 'PUBLISHED' : 'DRAFT',
        },
        discipline: { disciplineVersionId: dv, sport: fcodes.sport, discipline: fcodes.discipline },
        asOf: later(asOfMin),
        ...extra,
      });
    const cand = (n: number, holder: number, value: string, p: object = {}) =>
      rankCandidate(n, holder, value, { occurredAt: later(60), ...p });
    return { ...s, input, cand, later };
  }

  const run = (input: unknown) => persistRankingRun(fw, { input, trigger: 'STAFF_REQUEST' });

  it('31, 38 & 49. a PUBLISHABLE fixture run publishes an INITIAL snapshot with every entry; the next FOLLOWS', async () => {
    const s = await fixtureSystem();
    const r1 = await run(
      s.input([s.cand(1, 1, '900000'), s.cand(2, 2, '905000'), s.cand(3, 3, '900000')]),
    );
    expect(r1).toMatchObject({
      provenance: 'REFERENCE_FIXTURE',
      publicationState: 'PUBLISHABLE',
      entryCount: 3,
    });
    const snap = await publishRankingSnapshot(fw, { runId: r1.runId });
    expect(snap).toMatchObject({ lineageKind: 'INITIAL', entryCount: 3, created: true });
    const { rows } = await sql<{ rank: number; tied: boolean }>`
      SELECT rank, tied FROM ranking.snapshot_entry WHERE snapshot_id = ${snap.snapshotId} ORDER BY rank, holder_id`.execute(
      fowner,
    );
    expect(rows).toEqual([
      { rank: 1, tied: true },
      { rank: 1, tied: true },
      { rank: 3, tied: false },
    ]); // shared ranks, no hidden tie-break
    const { rows: c } = await sql<{ content: unknown; snapshot_hash: string }>`
      SELECT content, snapshot_hash FROM ranking.snapshot WHERE id = ${snap.snapshotId}`.execute(
      fowner,
    );
    const v = validateRankingSnapshot(c[0]?.content);
    expect(v.ok && v.hash).toBe(c[0]?.snapshot_hash);
    const { rows: ev } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.outbox_event
      WHERE event_type = 'RankingSnapshotPublished' AND aggregate_id = ${snap.snapshotId}`.execute(
      fowner,
    );
    expect(ev[0]?.n).toBe('1');
    const { rows: au } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM platform.audit_event
      WHERE action = 'ranking.snapshot-published' AND target_id = ${snap.snapshotId}`.execute(
      fowner,
    );
    expect(au[0]?.n).toBe('1');

    const r2 = await run(s.input([s.cand(1, 1, '899000'), s.cand(2, 2, '905000')], {}, 180));
    const next = await publishRankingSnapshot(fw, { runId: r2.runId });
    expect(next).toMatchObject({ lineageKind: 'FOLLOWS', priorSnapshotId: snap.snapshotId });
  });

  it('39. repeating a publication (sequentially or concurrently) creates no duplicate snapshot', async () => {
    const s = await fixtureSystem();
    const r = await run(s.input([s.cand(1, 1, '900000')]));
    const outs = await Promise.all(
      [1, 2, 3].map(() => publishRankingSnapshot(fw, { runId: r.runId })),
    );
    expect(new Set(outs.map((o) => o.snapshotId)).size).toBe(1);
    expect(outs.filter((o) => o.created)).toHaveLength(1);
    const again = await publishRankingSnapshot(fw, { runId: r.runId });
    expect(again).toMatchObject({ snapshotId: outs[0]?.snapshotId, created: false });
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ranking.snapshot WHERE run_id = ${r.runId}`.execute(fowner);
    expect(rows[0]?.n).toBe('1');
  });

  it('32–33. BLOCKED and empty runs are persisted with blockers but never publish', async () => {
    const s = await fixtureSystem();
    const held = await run(s.input([s.cand(1, 1, '900000', { hold: { active: true } })]));
    expect(held).toMatchObject({
      publicationState: 'BLOCKED',
      publicationReasons: ['NO_RANKED_ENTRIES'],
    });
    const empty = await run(s.input([], {}, 30));
    expect(empty).toMatchObject({ publicationState: 'BLOCKED', candidateCount: 0 });
    for (const runId of [held.runId, empty.runId])
      await expect(publishRankingSnapshot(fw, { runId })).rejects.toMatchObject({
        details: { reason: 'RUN_NOT_PUBLISHABLE', reasons: ['NO_RANKED_ENTRIES'] },
      });
  });

  it('34–35. a claimed snapshot content or hash that differs from the run is refused', async () => {
    const s = await fixtureSystem();
    const r = await run(s.input([s.cand(1, 1, '900000'), s.cand(2, 2, '901000')]));
    await expect(
      publishRankingSnapshot(fw, { runId: r.runId, claimed: { snapshotHash: randomHash() } }),
    ).rejects.toMatchObject({ details: { reason: 'SNAPSHOT_HASH_MISMATCH' } });
    const { rows } = await sql<{ outcome: { entries: Record<string, unknown>[] } }>`
      SELECT outcome FROM ranking.run WHERE id = ${r.runId}`.execute(fowner);
    const entries = rows[0]?.outcome.entries ?? [];
    const swapped = entries.map((e, i) => ({
      ...e,
      holder: entries[entries.length - 1 - i]?.holder,
    }));
    await expect(
      publishRankingSnapshot(fw, {
        runId: r.runId,
        claimed: {
          content: {
            systemId: s.systemId,
            systemVersionId: s.systemVersionId,
            specHash: s.specHash,
            kind: 'PLATFORM',
            method: 'BEST_MARK',
            engineVersion: 'ranking-engine/1',
            provenance: 'REFERENCE_FIXTURE',
            runInputHash: r.inputHash,
            runOutcomeHash: r.outcomeHash,
            asOf: s.later(120),
            lineage: { kind: 'INITIAL' },
            entries: swapped,
          },
        },
      }),
    ).rejects.toMatchObject({ details: { reason: 'SNAPSHOT_CONTENT_MISMATCH' } });
    expect(
      (
        await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM ranking.snapshot WHERE run_id = ${r.runId}`.execute(
          fowner,
        )
      ).rows[0]?.n,
    ).toBe('0');
  });

  it('36–37. an unpublished or retired system version cannot publish (canonical lifecycle, never the claimed one)', async () => {
    const draft = await fixtureSystem({}, 'PLATFORM', false);
    const blocked = await run(draft.input([draft.cand(1, 1, '900000')]));
    expect(blocked.publicationReasons).toEqual(['SYSTEM_VERSION_NOT_PUBLISHED']);
    // A fixture input LYING that the DRAFT version is PUBLISHED evaluates PUBLISHABLE — the writer
    // still refuses, from the stored lifecycle.
    const liar = await run(
      draft.input([draft.cand(1, 1, '900000')], {
        system: {
          systemId: draft.systemId,
          systemVersionId: draft.systemVersionId,
          code: (draft.input([]) as { system: { code: string } }).system.code,
          version: draft.version,
          specHash: draft.specHash,
          lifecycle: 'PUBLISHED',
        },
      }),
    );
    expect(liar.publicationState).toBe('PUBLISHABLE');
    await expect(publishRankingSnapshot(fw, { runId: liar.runId })).rejects.toMatchObject({
      details: { reason: 'SYSTEM_VERSION_NOT_PUBLISHED' },
    });
    const s = await fixtureSystem();
    const r = await run(s.input([s.cand(1, 1, '900000')]));
    await fop.changeRankingSystemVersionStatus({
      operatorAccountId,
      systemVersionId: s.systemVersionId,
      status: 'RETIRED',
    });
    await expect(publishRankingSnapshot(fw, { runId: r.runId })).rejects.toMatchObject({
      details: { reason: 'SYSTEM_VERSION_RETIRED' },
    });
  });

  it('40–41. snapshots are immutable; CORRECTS pins only the head (fixture lane) and corrects it once', async () => {
    const s = await fixtureSystem();
    const a = await publishRankingSnapshot(fw, {
      runId: (await run(s.input([s.cand(1, 1, '900000')]))).runId,
    });
    const b = await publishRankingSnapshot(fw, {
      runId: (await run(s.input([s.cand(1, 1, '900000'), s.cand(2, 2, '901000')], {}, 150))).runId,
    });
    const c3 = (await run(s.input([s.cand(2, 2, '901000')], {}, 160))).runId;
    // Only the head (b) can be corrected; correcting the superseded INITIAL snapshot is invalid lineage.
    await expect(
      publishRankingSnapshot(fw, {
        runId: c3,
        correction: { correctsSnapshotId: a.snapshotId, reasons: ['RESULT_SUPERSEDED'] },
      }),
    ).rejects.toMatchObject({ details: { reason: 'LINEAGE_INVALID' } });
    const corr = await publishRankingSnapshot(fw, {
      runId: c3,
      correction: { correctsSnapshotId: b.snapshotId, reasons: ['RESULT_SUPERSEDED'] },
    });
    expect(corr).toMatchObject({ lineageKind: 'CORRECTS', priorSnapshotId: b.snapshotId });
    const { rows } = await sql<{ corrects: string; reasons: string[] }>`
      SELECT corrects_snapshot_id::text AS corrects, lineage_reasons AS reasons FROM ranking.snapshot
      WHERE id = ${corr.snapshotId}`.execute(fowner);
    expect(rows[0]).toEqual({ corrects: b.snapshotId, reasons: ['RESULT_SUPERSEDED'] });
    for (const stmt of [
      sql`UPDATE ranking.snapshot SET entry_count = 9 WHERE id = ${a.snapshotId}`,
      sql`DELETE FROM ranking.snapshot_entry WHERE snapshot_id = ${a.snapshotId}`,
    ])
      await expect(stmt.execute(fowner)).rejects.toMatchObject(APPEND_ONLY);
  });

  it('42. OFFICIAL publication fails closed even when a fixture owner act makes the run PUBLISHABLE', async () => {
    const fauthority = new AuthorityStore(fapi, { conflictChecker: declaredNoParticipation });
    const org = await fauthority.registerPrincipal({
      principalType: 'ORGANIZATION',
      label: 'fictional federation (fixture)',
    });
    const covered = { recognitionLevel: ['NATIONAL'], sport: [fcodes.sport], region: ['CR'] };
    const { anchorId } = await fauthority.recognizeTrustAnchor({
      principalId: org.id,
      recognitionScope: covered as never,
      basisRef: 'fixture',
      governanceDecisionRef: k('gov'),
    });
    const s = await fixtureSystem(
      {
        displayName: 'Fictional association marks',
        kind: 'OFFICIAL',
        requirements: { minimumVerificationLevel: 'V3', minimumResultStatus: 'FINAL' },
        recognition: { level: 'NATIONAL', sport: [fcodes.sport], region: ['CR'] },
        owner: { principalId: org.id, anchorId },
      },
      'OFFICIAL',
    );
    const base = rankCandidate(1, 1, '900000').verification;
    const official = s.cand(1, 1, '900000', {
      verification: {
        ...base,
        level: 'V3',
        governingRecognition: {
          recognitionLevel: 'NATIONAL',
          anchorId,
          source: 'SANCTION',
          anchorFactHash: base.snapshotHash,
          recognitionScope: covered,
        },
      },
    });
    const withoutAct = await run(s.input([official]));
    expect(withoutAct.publicationReasons).toEqual(['OWNER_PUBLICATION_UNAVAILABLE']);
    const withFixtureAct = await run(
      s.input([official], {
        supportedFactKinds: [...FIXTURE_FACT_KINDS, 'RANKING_PUBLICATION'],
        publication: { provenance: 'REFERENCE_FIXTURE', ref: newId(), ownerPrincipalId: org.id },
      }),
    );
    expect(withFixtureAct.publicationState).toBe('PUBLISHABLE');
    await expect(publishRankingSnapshot(fw, { runId: withoutAct.runId })).rejects.toMatchObject({
      details: { reason: 'RUN_NOT_PUBLISHABLE', reasons: ['OWNER_PUBLICATION_UNAVAILABLE'] },
    });
    await expect(publishRankingSnapshot(fw, { runId: withFixtureAct.runId })).rejects.toMatchObject(
      {
        details: { reason: 'OWNER_PUBLICATION_UNAVAILABLE' },
      },
    );
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM ranking.snapshot WHERE system_id = ${s.systemId}`.execute(
      fowner,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('the fixture database is the throwaway lane (never the canonical one)', () => {
    expect(fx.database).toMatch(/^br_rkfx_[0-9a-f]{12}$/);
  });
});
