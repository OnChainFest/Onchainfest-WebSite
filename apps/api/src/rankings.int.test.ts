import { readFileSync } from 'node:fs';
import { DomainError } from '@br/domain';
import { newId, type AuthorityScope, type Uuid } from '@br/domain';
import {
  AuthorityStore,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  createCompetitionResultLedger,
  createDb,
  databaseUrls,
  IdentityStore,
  inTransaction,
  ModuleRole,
  OrganizationReader,
  OrganizationStore,
  operatorDatabaseUrl,
  PassportReader,
  RankingDefinitionStore,
  RankingService,
  RankingStaffReader,
  rankingOperatorDatabaseUrl,
  rankingWorkerDatabaseUrl,
  rebuildRankingReadModels,
  StructureStore,
  type Db,
} from '@br/persistence';
import {
  persistRankingRun,
  publishRankingSnapshot,
  rankingFixturePublicReader,
} from '@br/persistence/ranking-lanes';
import { forbiddenMembers } from '@br/rankings';
import { rankCandidate, rankingRunInput, rankingSpec } from '@br/rankings/fixtures';
import {
  apiDb,
  declaredNoParticipation,
  maintenanceDb,
  newContestResult,
  newTestAccount,
  operatorDb,
  ownerDb,
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
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';
import { errorBody, registerV1 } from './v1';

/**
 * BRT-10 Step 11 through the real /v1 surface.
 *
 *   CANONICAL PRODUCTION lane (normal schema): ranking systems, empty snapshot history (production holds
 *   zero snapshots), `@2` classifications with read-time staleness (CURRENT → STALE through a newly
 *   accepted contest), status visibility (SUBMITTED / REJECTED / REVOKED / `@1` → 404), the COMP_STAFF
 *   proposal (closed body, staff check, writes nothing), the INTERNAL run read (dedicated SELECT-only
 *   role), projection drift → PROJECTION_MISMATCH, least privilege and a leak scan.
 *   REFERENCE FIXTURE lane (throwaway br_rkfx_ database; NOT SPORTING TRUTH): the same routes over a
 *   real INITIAL → FOLLOWS → CORRECTS → CORRECTS → FOLLOWS lineage — as-published / as-corrected, snapshot
 *   detail (STALE: synthetic pins are unknown to the canonical tables), leaderboard with shared ties —
 *   and proof that the production reader never exposes those fixture rows.
 *
 * ALL DATA IS FICTIONAL.
 */
const SECRET = `ranking-int-auth-secret-${newId()}`;
const DENIED = { code: '42501' };
const tag = newId().replace(/-/g, '').slice(-10);
const logLines: string[] = [];
const db = apiDb();
const owner = ownerDb();
const maintenance = maintenanceDb();
const catalogOperator = operatorDb();
const rop = rankingOperatorDb();
const rw = rankingWorkerDb();
const app = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  logStream: { write: (line: string) => void logLines.push(line) },
});
afterAll(async () => {
  await app.close();
  await Promise.all([db, owner, maintenance, catalogOperator, rop, rw].map((d) => d.destroy()));
});

const VECTORS = JSON.parse(
  readFileSync(
    new URL('../../../packages/rankings/test-vectors/brt-10-api.vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  vectors: { name: string; kind: string; canonicalText: string; input: { status: number } }[];
};
const errorVector = (name: string) => {
  const v = VECTORS.vectors.find((x) => x.name === name);
  if (v === undefined) throw new Error(`no vector ${name}`);
  return { status: v.input.status, body: JSON.parse(v.canonicalText) as unknown };
};

const bearer = (sub: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(sub, { secret: SECRET, operator })}`,
});
const idem = () => ({ 'idempotency-key': `k-${newId()}` });
const k = (p = 'k') => `${p}-${newId()}`;
const futureIso = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const publicBodies: string[] = [];
const staffBodies: string[] = [];

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
  server: FastifyInstance = app,
) {
  const res = await server.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  if (url.includes('/internal/') || url.includes('classification-proposals'))
    staffBodies.push(res.body);
  else if (/ranking|classification/.test(url)) publicBodies.push(res.body);
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON navigation in tests
    json: res.json() as any,
  };
}

const orgH = bearer(`rk-org-${tag}`);
const strangerH = bearer(`rk-stranger-${tag}`);
const opH = bearer(`rk-operator-${tag}`, true);

let catalog: TestCatalog;
let organizer: {
  ownerAccountId: string;
  ownerPersonId: string;
  organizationId: string;
  slug: string;
};
const authority = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const definitions = new RankingDefinitionStore(rop);
const scopeOf = async (level: 'CONTEST' | 'EVENT' | 'COMPETITION', id: string) =>
  ({ ...(await resolver.scopeOf(level, id)), recognitionLevel: ['PLATFORM'] }) as AuthorityScope;

/** A real accepted (PROVISIONAL) timed contest result, optionally in an existing competition. */
async function world(timed: { winnerMs: string; loserMs: string }, competitionId?: string) {
  const w = await newContestResult({
    db,
    identity: new IdentityStore(db),
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority,
    ledger,
    resolver,
    catalog,
    timed,
    organizer,
    ...(competitionId === undefined ? {} : { competitionId }),
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
  await ledger.transition({
    resultVersionId: w.resultVersionId,
    toStatus: 'PROVISIONAL',
    actorPrincipalId: acceptor.id,
    scope: await scopeOf('CONTEST', w.contestId),
    idempotencyKey: k('accept'),
  });
  return { ...w, acceptorId: acceptor.id };
}

/** Submits the canonical `@2` competition classification (T2): SUBMITTED, not yet public. */
async function submitCompetitionClassification(w: Awaited<ReturnType<typeof world>>) {
  const { id: resultId } = await ledger.createResult({
    scopeType: 'COMPETITION_CLASSIFICATION',
    scopeTargetId: w.competitionId as Uuid,
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
    scope: await scopeOf('COMPETITION', w.competitionId),
    idempotencyKey: k('submit'),
  });
  return {
    resultId,
    versionId: s.resultVersionId as string,
    contentHash: s.contentHash as string,
    content: p.outcome.proposal.content,
  };
}

const decide = async (
  w: Awaited<ReturnType<typeof world>>,
  versionId: string,
  toStatus: 'PROVISIONAL' | 'REJECTED',
) =>
  ledger.transition({
    resultVersionId: versionId as Uuid,
    toStatus,
    actorPrincipalId: w.acceptorId,
    scope: await scopeOf('COMPETITION', w.competitionId),
    idempotencyKey: k('decide'),
  });

/** Row counts + content fingerprints of every canonical table a read could (wrongly) touch. */
async function canonicalFingerprint(d: Db) {
  const out: Record<string, unknown> = {};
  for (const t of [
    'results.result',
    'results.result_version',
    'results.result_status_transition',
    'results.classification_derivation',
    'results.classification_input',
    'results.result_draft',
    'ranking.system',
    'ranking.system_version',
    'ranking.run',
    'ranking.run_dependency',
    'ranking.snapshot',
    'ranking.snapshot_entry',
    'achievement.achievement',
    'platform.outbox_event',
    'platform.audit_event',
    'platform.ledger_entry',
  ])
    out[t] = (
      await sql
        .raw<{
          n: string;
          h: string;
        }>(
          `SELECT count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`,
        )
        .execute(d)
    ).rows[0];
  return out;
}

const COMPETITION_POLICY_SPEC = (dv: string) => ({
  targetEngine: 'classification-engine/1',
  displayName: 'Fictional competition table',
  scopeType: 'COMPETITION_CLASSIFICATION',
  disciplineVersionId: dv,
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

beforeAll(async () => {
  const ownerAccountId = (await call('GET', '/v1/me', orgH)).json.accountId as string;
  const ownerPersonId = (
    await call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' })
  ).json.personId as string;
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...orgH, ...idem() },
    {
      orgType: 'CLUB',
      slug: uniqueSlug('rkorg'),
      profile: { displayName: 'Fictional Ranking Club' },
    },
  );
  organizer = {
    ownerAccountId,
    ownerPersonId,
    organizationId: org.json.organizationId,
    slug: org.json.slug,
  };
  catalog = await seedTestCatalog(new IdentityStore(db), new CatalogStore(catalogOperator));
  // First authentication provisions an account (a write): do it before any footprint is taken.
  for (const h of [strangerH, opH]) expect((await call('GET', '/v1/me', h)).status).toBe(200);
}, 180_000);

// ═════════════════════════════ canonical production lane ═════════════════════════════

describe('BRT-10 /v1 rankings — canonical lane', () => {
  let platform: { systemId: string; code: string; systemVersionId: string };
  let draftOnly: { systemId: string; code: string };
  let w: Awaited<ReturnType<typeof world>>;
  let cls: Awaited<ReturnType<typeof submitCompetitionClassification>>;
  let policyVersionId: string;
  let runId: string;

  beforeAll(async () => {
    // The (scope type, DisciplineVersion) policy binding is unique-or-fail: publish the only one.
    for (const r of (
      await sql<{ id: string }>`
        SELECT v.id::text AS id FROM ranking.classification_policy_version v
        JOIN ranking.v_classification_policy_version_current s ON s.policy_version_id = v.id
        WHERE v.scope_type = 'COMPETITION_CLASSIFICATION' AND v.discipline_version_id = ${catalog.timedSingles}
          AND s.status = 'PUBLISHED'`.execute(owner)
    ).rows)
      await definitions.changeClassificationPolicyVersionStatus({
        operatorAccountId: catalog.operatorAccountId,
        policyVersionId: r.id,
        status: 'RETIRED',
      });
    const { policyId } = await definitions.createClassificationPolicy({
      operatorAccountId: catalog.operatorAccountId,
      code: `cp-${newId().slice(-12)}`,
      name: 'Fictional table',
      scopeType: 'COMPETITION_CLASSIFICATION',
      idempotencyKey: k('cp'),
    });
    policyVersionId = (
      await definitions.createClassificationPolicyVersion({
        operatorAccountId: catalog.operatorAccountId,
        policyId,
        spec: COMPETITION_POLICY_SPEC(catalog.timedSingles),
        idempotencyKey: k('cpv'),
      })
    ).policyVersionId;
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId,
      status: 'PUBLISHED',
    });

    const { rows } = await sql<{ sport: string }>`
      SELECT s.code AS sport FROM sports.discipline_version v JOIN sports.discipline d ON d.id = v.discipline_id
      JOIN sports.sport s ON s.id = d.sport_id WHERE v.id = ${catalog.timedSingles}`.execute(owner);
    const spec = rankingSpec({
      universe: {
        disciplineVersionId: catalog.timedSingles,
        metric: { key: 'elapsedTimeMs', markMetricId: 'athletics.100m.time' },
        resultScope: 'CONTEST',
        holderType: 'ATHLETE',
        population: {},
      },
      recognition: { level: 'PLATFORM', sport: [rows[0]?.sport] },
      effectiveFrom: futureIso(3),
    });
    const mkSystem = async (code: string) => {
      const { systemId } = await definitions.createRankingSystem({
        operatorAccountId: catalog.operatorAccountId,
        code,
        name: 'Fictional best marks',
        kind: 'PLATFORM',
        idempotencyKey: k('rs'),
      });
      const v = await definitions.createRankingSystemVersion({
        operatorAccountId: catalog.operatorAccountId,
        systemId,
        spec,
        idempotencyKey: k('rsv'),
      });
      return { systemId, code, systemVersionId: v.systemVersionId };
    };
    platform = await mkSystem(`rk-api-${tag}`);
    await definitions.changeRankingSystemVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      systemVersionId: platform.systemVersionId,
      status: 'PUBLISHED',
    });
    draftOnly = await mkSystem(`rk-draft-${tag}`);

    w = await world({ winnerMs: '10870', loserMs: '11020' });
    cls = await submitCompetitionClassification(w);
    runId = (
      await new RankingService(rw).evaluate({
        systemVersionId: platform.systemVersionId,
        trigger: 'STAFF_REQUEST',
      })
    ).runId;
  }, 300_000);
  afterAll(async () => {
    await definitions.changeClassificationPolicyVersionStatus({
      operatorAccountId: catalog.operatorAccountId,
      policyVersionId,
      status: 'RETIRED',
    });
  });

  it('exactly the nine BRT-10 routes, classified as decided; no write, publish, evaluate or qualification route', () => {
    // ONCF-05C adds exactly one in-event classification route: a COMP_STAFF read of a computed
    // proposal (ADR-0063). It is pinned here so it can never become a write surface unnoticed.
    const oncf05c = (r: { url: string }) => r.url.startsWith('/v1/events/');
    expect(
      app.v1Routes
        .filter((r) => oncf05c(r) && /ranking|classification/.test(r.url))
        .map((r) => `${r.method} ${r.url} ${r.classification}`),
    ).toEqual(['GET /v1/events/:eventId/stages/:stageKey/classification COMP_STAFF']);
    const brt10 = app.v1Routes.filter((r) => !oncf05c(r) && /ranking|classification/.test(r.url));
    expect(brt10.map((r) => `${r.method} ${r.url} ${r.classification}`).sort()).toEqual(
      [
        'GET /v1/ranking-systems PUBLIC',
        'GET /v1/ranking-systems/:system PUBLIC',
        'GET /v1/ranking-systems/:system/snapshots PUBLIC',
        'GET /v1/ranking-snapshots/:snapshotId PUBLIC',
        'GET /v1/ranking-snapshots/:snapshotId/leaderboard PUBLIC',
        'GET /v1/result-versions/:resultVersionId/classification PUBLIC',
        'GET /v1/result-versions/:resultVersionId/classification/entries PUBLIC',
        'POST /v1/result-versions/:resultVersionId/classification-proposals COMP_STAFF',
        'GET /v1/internal/ranking-runs/:runId INTERNAL',
      ].sort(),
    );
    expect(app.v1Routes.filter((r) => /qualification/i.test(r.url))).toEqual([]);
  });

  it('ranking systems: published PLATFORM by code and by id; DRAFT-only hidden; bounded cursor pages', async () => {
    const byCode = await call('GET', `/v1/ranking-systems/${platform.code}`);
    expect(byCode.status).toBe(200);
    expect(byCode.json).toMatchObject({
      schema: 'br:public-ranking-system@1',
      systemId: platform.systemId,
      code: platform.code,
      kind: 'PLATFORM',
      label: 'Bragging Rights platform ranking',
      version: { latest: 1, lifecycle: 'PUBLISHED', published: 1 },
      universe: { disciplineVersionId: catalog.timedSingles, holderType: 'ATHLETE' },
    });
    expect(byCode.json.ownerPublication).toBeUndefined();
    const byId = await call('GET', `/v1/ranking-systems/${platform.systemId}`);
    expect(byId.json).toEqual(byCode.json);
    expect(forbiddenMembers(byCode.json)).toEqual([]);
    for (const ref of [draftOnly.code, draftOnly.systemId, newId(), 'zz-unknown-system'])
      expect(await call('GET', `/v1/ranking-systems/${ref}`)).toMatchObject({
        status: 404,
        json: errorVector('error/system-not-found').body,
      });
    expect((await call('GET', '/v1/ranking-systems/Not_A_Code!')).status).toBe(400);

    // Walk every page (limit 1): sorted by code, ours included, the draft-only system never listed.
    const codes: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 500; i++) {
      const page = await call(
        'GET',
        `/v1/ranking-systems?limit=1${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      );
      expect(page.status).toBe(200);
      expect(page.json.schema).toBe('br:public-ranking-system-list@1');
      expect(page.json.items.length).toBeLessThanOrEqual(1);
      codes.push(...page.json.items.map((s: { code: string }) => s.code));
      cursor = page.json.nextCursor;
      if (cursor === undefined) break;
    }
    expect(codes).toContain(platform.code);
    expect(codes).not.toContain(draftOnly.code);
    expect([...codes].sort()).toEqual(codes);
  });

  it('cursors and limits are bounded; an undecodable cursor is a 400, never the first page', async () => {
    const invalid = errorVector('error/invalid-cursor');
    for (const c of [
      'QSBC', // base64url('A B'): decodes, but is not a key
      'YWJjZ', // non-canonical encoding of 'abc'
      Buffer.from('1|ATHLETE|nope').toString('base64url'),
    ]) {
      for (const url of [
        `/v1/ranking-systems?cursor=${c}`,
        `/v1/ranking-systems/${platform.code}/snapshots?cursor=${c}`,
      ])
        expect(await call('GET', url)).toMatchObject({
          status: invalid.status,
          json: invalid.body,
        });
    }
    for (const q of [
      `cursor=${'A'.repeat(401)}`,
      'cursor=%27%3B--',
      'limit=0',
      'limit=51',
      'limit=abc',
      'sort=rank',
      'order=desc',
      'filter=x',
    ]) {
      const r = await call('GET', `/v1/ranking-systems?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json.error.code).toBe('INVALID_INPUT');
    }
    expect((await call('GET', '/v1/ranking-systems?limit=50')).status).toBe(200);
  });

  it('snapshot history: both views are empty in production (zero snapshots); invalid view 400; unknown 404', async () => {
    for (const view of ['as-published', 'as-corrected']) {
      const r = await call('GET', `/v1/ranking-systems/${platform.code}/snapshots?view=${view}`);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({
        schema: 'br:public-ranking-snapshot-history@1',
        systemId: platform.systemId,
        view,
        items: [],
      });
    }
    expect(
      (await call('GET', `/v1/ranking-systems/${platform.code}/snapshots?view=latest`)).status,
    ).toBe(400);
    expect((await call('GET', `/v1/ranking-systems/${newId()}/snapshots`)).status).toBe(404);
  });

  it('snapshot + leaderboard: unknown → 404, malformed → 400 (exact API vector envelopes)', async () => {
    const nf = errorVector('error/snapshot-not-found');
    for (const url of [
      `/v1/ranking-snapshots/${newId()}`,
      `/v1/ranking-snapshots/${newId()}/leaderboard`,
    ])
      expect(await call('GET', url)).toMatchObject({ status: nf.status, json: nf.body });
    const bad = errorVector('error/malformed-snapshot-id');
    expect(await call('GET', '/v1/ranking-snapshots/not-a-uuid')).toMatchObject({
      status: bad.status,
      json: bad.body,
    });
    expect((await call('GET', '/v1/ranking-snapshots/not-a-uuid/leaderboard')).status).toBe(400);
  });

  it('a SUBMITTED classification is not public: 404 exactly like an unknown id (no existence leak)', async () => {
    const nf = errorVector('error/classification-not-found');
    for (const id of [cls.versionId, newId()]) {
      for (const suffix of ['', '/entries']) {
        const r = await call('GET', `/v1/result-versions/${id}/classification${suffix}`);
        expect(r.status).toBe(nf.status);
        expect(r.json).toEqual(nf.body);
      }
    }
    expect((await call('GET', '/v1/result-versions/not-a-uuid/classification')).status).toBe(400);
  });

  it('COMP_STAFF proposal: closed empty body, competition staff only (else 404), canonical, writes nothing', async () => {
    const url = `/v1/result-versions/${cls.versionId}/classification-proposals`;
    const before = await canonicalFingerprint(owner);
    const ok = await call('POST', url, orgH, {});
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({
      schema: 'br:staff-classification-proposal@1',
      resultVersionId: cls.versionId,
      resultId: cls.resultId,
      state: 'PROPOSED',
    });
    // Derived from canonical facts: byte-equal to the submitted content (same hash).
    expect(ok.json.outcome.proposal.contentHash).toBe(cls.contentHash);
    expect(await canonicalFingerprint(owner)).toEqual(before);

    const nf = errorVector('error/proposal-not-found');
    for (const [h, id] of [
      [strangerH, cls.versionId],
      [orgH, newId()],
    ] as const)
      expect(
        await call('POST', `/v1/result-versions/${id}/classification-proposals`, h, {}),
      ).toMatchObject({
        status: nf.status,
        json: nf.body,
      });
    expect((await call('POST', url, {}, {})).status).toBe(401);
    for (const body of [
      { ranks: [1] },
      { ties: [] },
      { values: ['1'] },
      { participants: [newId()] },
      { policyVersionId: policyVersionId },
      { inputs: [w.resultVersionId] },
      { contentHash: cls.contentHash },
      { verificationLevel: 'V4' },
      { holder: newId() },
      { force: true },
      { override: true },
      { content: cls.content },
    ]) {
      const r = await call('POST', url, orgH, body);
      expect(r.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(r.json.error.code).toBe('INVALID_INPUT');
    }
    // A CONTEST version has no classification to propose: reported, never invented.
    const contest = await call(
      'POST',
      `/v1/result-versions/${w.resultVersionId}/classification-proposals`,
      orgH,
      {},
    );
    expect(contest.json).toMatchObject({
      state: 'UNAVAILABLE',
      reason: 'NOT_A_CLASSIFICATION_RESULT',
    });
    expect(await canonicalFingerprint(owner)).toEqual(before);
  });

  it('accepted (PROVISIONAL) classification: card + rows + read-time CURRENT; no derivedFrom topology', async () => {
    await decide(w, cls.versionId, 'PROVISIONAL');
    const before = await canonicalFingerprint(owner);
    const r = await call('GET', `/v1/result-versions/${cls.versionId}/classification`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      schema: 'br:public-classification@1',
      classification: {
        resultVersionId: cls.versionId,
        resultId: cls.resultId,
        scopeType: 'COMPETITION_CLASSIFICATION',
        scopeTargetId: w.competitionId,
        versionNumber: 1,
        status: 'PROVISIONAL',
        statusSince: expect.any(String),
        submittedAt: expect.any(String),
        contentHash: cls.contentHash,
        entryCount: 2,
        provenance: {
          available: true,
          policy: { policyId: expect.any(String), policyVersionId, specHash: expect.any(String) },
          disciplineVersionId: catalog.timedSingles,
          engineVersion: 'classification-engine/1',
          inputsDigest: expect.stringMatching(/^sha256:/),
          inputCount: 1,
        },
      },
      readTime: { staleness: { state: 'CURRENT', reasons: [] } },
    });
    // The exact derivedFrom pin (the contest ResultVersion) is not public topology.
    expect(r.text).not.toContain(w.resultVersionId);
    expect(forbiddenMembers(r.json)).toEqual([]);

    const e = await call('GET', `/v1/result-versions/${cls.versionId}/classification/entries`);
    expect(e.status).toBe(200);
    expect(e.json.schema).toBe('br:public-classification-entries@1');
    expect(e.json.contentHash).toBe(cls.contentHash);
    const expected = [
      ...(
        cls.content as unknown as {
          entries: {
            participantId: string;
            rank: number;
            tied: boolean;
            tieBreakKeys: unknown[];
          }[];
        }
      ).entries,
    ]
      .sort((a, b) => a.rank - b.rank || (a.participantId < b.participantId ? -1 : 1))
      .map((x) => ({
        participantId: x.participantId,
        rank: x.rank,
        tied: x.tied,
        tieBreakKeys: x.tieBreakKeys,
      }));
    expect(
      e.json.entries.map((x: Record<string, unknown>) => ({
        participantId: x.participantId,
        rank: x.rank,
        tied: x.tied,
        tieBreakKeys: x.tieBreakKeys,
      })),
    ).toEqual(expected);
    for (const x of e.json.entries)
      expect(['ATHLETE', 'TEAM', 'PRIVATE_ENTRANT']).toContain(x.display.kind);
    // Paging: one row per page, then the cursor continues in canonical order.
    const p1 = await call(
      'GET',
      `/v1/result-versions/${cls.versionId}/classification/entries?limit=1`,
    );
    expect(p1.json.entries).toHaveLength(1);
    const p2 = await call(
      'GET',
      `/v1/result-versions/${cls.versionId}/classification/entries?limit=1&cursor=${p1.json.nextCursor}`,
    );
    expect(
      [...p1.json.entries, ...p2.json.entries].map(
        (x: { participantId: string }) => x.participantId,
      ),
    ).toEqual(expected.map((x) => x.participantId));
    expect(p2.json.nextCursor).toBeUndefined();
    expect(
      (await call('GET', `/v1/result-versions/${cls.versionId}/classification/entries?cursor=QSBC`))
        .status,
    ).toBe(400);
    // Reads computed staleness and wrote nothing.
    expect(await canonicalFingerprint(owner)).toEqual(before);
  });

  it('a newly accepted contest in scope makes it STALE at read time (pinned policy); nothing stored, no ids leaked', async () => {
    const second = await world({ winnerMs: '10950', loserMs: '11050' }, w.competitionId);
    const before = await canonicalFingerprint(owner);
    const r = await call('GET', `/v1/result-versions/${cls.versionId}/classification`);
    expect(r.status).toBe(200);
    expect(r.json.readTime).toEqual({
      staleness: { state: 'STALE', reasons: ['ADMISSIBLE_INPUT_SET_CHANGED'] },
    });
    // The stored facts did not move: same hash, same status, same entries.
    expect(r.json.classification).toMatchObject({
      contentHash: cls.contentHash,
      status: 'PROVISIONAL',
    });
    expect(r.text).not.toContain(second.resultVersionId);
    expect(r.text).not.toMatch(/staleDigest|notCurrent|added|removed/);
    expect(await canonicalFingerprint(owner)).toEqual(before);
    // No staleness / current column exists in any projection.
    const { rows } = await sql<{ c: string }>`
      SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = 'ranking_read' AND column_name ~ '(stale|current)'`.execute(owner);
    expect(rows).toEqual([]);
  });

  it('`@1` classifications and CONTEST versions are not public classifications (404)', async () => {
    const { id: resultId } = await ledger.createResult({
      scopeType: 'EVENT_CLASSIFICATION',
      scopeTargetId: w.eventId as Uuid,
    });
    // A pre-BRT-10 style `@1` classification: entries with ranks, no derivation (no provenance).
    const legacy = {
      entries: (
        cls.content as unknown as { entries: { participantId: string; rank: number }[] }
      ).entries.map((e) => ({ participantId: e.participantId, outcome: 'RANKED', rank: e.rank })),
    };
    const { draftId } = await ledger.saveDraft({
      resultId,
      authorPrincipalId: w.submitterPrincipalId as Uuid,
      disciplineVersionRef: 'timed.singles@1',
      content: legacy as never,
    });
    const s = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.submitterPrincipalId as Uuid,
      scope: await scopeOf('EVENT', w.eventId),
      idempotencyKey: k('legacy'),
    });
    await ledger.transition({
      resultVersionId: s.resultVersionId as Uuid,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: w.acceptorId,
      scope: await scopeOf('EVENT', w.eventId),
      idempotencyKey: k('legacy-accept'),
    });
    const { rows } = await sql<{ schema: string }>`
      SELECT content_schema AS schema FROM results.result_version WHERE id = ${s.resultVersionId}`.execute(
      owner,
    );
    expect(rows[0]?.schema).toBe('br:result-version-content@1');
    for (const id of [s.resultVersionId, w.resultVersionId])
      for (const suffix of ['', '/entries'])
        expect(
          (await call('GET', `/v1/result-versions/${id}/classification${suffix}`)).status,
        ).toBe(404);
  });

  it('REJECTED and REVOKED classifications are not public (404)', async () => {
    const w3 = await world({ winnerMs: '10800', loserMs: '10900' });
    const rejected = await submitCompetitionClassification(w3);
    await decide(w3, rejected.versionId, 'REJECTED');
    expect(
      (await call('GET', `/v1/result-versions/${rejected.versionId}/classification`)).status,
    ).toBe(404);
    // REVOKED has no canonical producer (no T8): the public status filter is exercised on the projection.
    await sql`UPDATE ranking_read.classification_card SET status = 'REVOKED'
              WHERE classification_version_id = ${cls.versionId}`.execute(owner);
    for (const suffix of ['', '/entries'])
      expect(
        (await call('GET', `/v1/result-versions/${cls.versionId}/classification${suffix}`)).status,
      ).toBe(404);
    await rebuildRankingReadModels(maintenance);
    expect((await call('GET', `/v1/result-versions/${cls.versionId}/classification`)).status).toBe(
      200,
    );
  });

  it('projection drift is never served: PROJECTION_MISMATCH (500), canonical facts untouched, rebuild restores', async () => {
    const mismatch = errorVector('error/projection-mismatch');
    const before = await canonicalFingerprint(owner);
    const expectDrift = async (url: string) =>
      expect(await call('GET', url)).toMatchObject({
        status: mismatch.status,
        json: mismatch.body,
      });

    await sql`UPDATE ranking_read.classification_card SET content_hash = ${`sha256:${'0'.repeat(64)}`}
              WHERE classification_version_id = ${cls.versionId}`.execute(owner);
    await expectDrift(`/v1/result-versions/${cls.versionId}/classification`);
    await rebuildRankingReadModels(maintenance);

    await sql`UPDATE ranking_read.classification_entry SET rank = rank + 5
              WHERE classification_version_id = ${cls.versionId}`.execute(owner);
    await expectDrift(`/v1/result-versions/${cls.versionId}/classification/entries`);
    await rebuildRankingReadModels(maintenance);

    // A snapshot card / leaderboard row with no canonical snapshot behind it.
    const fake = newId();
    await sql`
      INSERT INTO ranking_read.snapshot_card
        (snapshot_id, system_id, system_version_id, system_version, spec_hash, run_id, run_input_hash,
         run_outcome_hash, snapshot_hash, kind, method, engine_version, provenance, as_of, lineage_kind,
         prior_snapshot_id, prior_snapshot_hash, lineage_reasons, chain_position, corrected_by_snapshot_id,
         entry_count, published_at)
      VALUES (${fake}, ${platform.systemId}, ${platform.systemVersionId}, 1, ${`sha256:${'1'.repeat(64)}`},
              ${runId}, ${`sha256:${'2'.repeat(64)}`}, ${`sha256:${'3'.repeat(64)}`}, ${`sha256:${'4'.repeat(64)}`},
              'PLATFORM', 'BEST_MARK', 'ranking-engine/1', 'CANONICAL_ASSEMBLY', now(), 'INITIAL', NULL, NULL,
              '{}', 1, NULL, 1, now())`.execute(owner);
    await sql`
      INSERT INTO ranking_read.leaderboard_entry
        (snapshot_id, holder_type, holder_id, rank, tied, value, comparator_trace, basis_count)
      VALUES (${fake}, 'ATHLETE', ${newId()}, 1, false,
              ${JSON.stringify({ metricId: 'athletics.100m.time', value: '1', unit: 'ms', precision: 0 })}::jsonb,
              '[]'::jsonb, 1)`.execute(owner);
    await expectDrift(`/v1/ranking-snapshots/${fake}`);
    await expectDrift(`/v1/ranking-snapshots/${fake}/leaderboard`);
    await rebuildRankingReadModels(maintenance);
    expect((await call('GET', `/v1/ranking-snapshots/${fake}`)).status).toBe(404);
    expect((await call('GET', `/v1/result-versions/${cls.versionId}/classification`)).status).toBe(
      200,
    );
    expect(await canonicalFingerprint(owner)).toEqual(before);
    // The failure body carries no SQL, role or projection detail.
    expect(logLines.join('\n')).not.toMatch(/ranking_read|SELECT |br_public_read|br_achievements/);
  });

  it('INTERNAL run read: operator only (401 / 403), every candidate with blockers, no-store, dedicated reader', async () => {
    const url = `/v1/internal/ranking-runs/${runId}`;
    expect((await call('GET', url)).status).toBe(401);
    expect((await call('GET', url, orgH)).status).toBe(403);
    const r = await call('GET', url, opH);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const { rows } = await sql<{ outcome_hash: string; candidate_count: number }>`
      SELECT outcome_hash, candidate_count FROM ranking.run WHERE id = ${runId}`.execute(owner);
    expect(r.json).toMatchObject({
      schema: 'br:staff-ranking-run@1',
      run: {
        runId,
        systemId: platform.systemId,
        publicationState: 'BLOCKED',
        outcomeHash: rows[0]?.outcome_hash,
        provenance: 'CANONICAL_ASSEMBLY',
      },
    });
    expect(r.json.candidates).toHaveLength(rows[0]?.candidate_count ?? -1);
    for (const c of r.json.candidates) expect(c.reasons.length).toBeGreaterThan(0);
    expect((await call('GET', `/v1/internal/ranking-runs/${newId()}`, opH)).status).toBe(404);
    expect((await call('GET', '/v1/internal/ranking-runs/not-a-uuid', opH)).status).toBe(400);
    // Nothing public serves run data.
    expect((await call('GET', `/v1/ranking-snapshots/${runId}`)).status).toBe(404);
    // The staff read goes through br_ranking_staff_reader, not br_rankings.
    expect(await new RankingStaffReader(db).run(runId)).toEqual(r.json);
  });

  it('least privilege: no ranking writer for br_api; the staff reader is SELECT-only on two projections; no PUBLIC grant', async () => {
    const setRole = (role: string) =>
      db.connection().execute(async (c) => {
        await sql`BEGIN`.execute(c);
        try {
          await sql.raw(`SET LOCAL ROLE ${role}`).execute(c);
        } finally {
          await sql`ROLLBACK`.execute(c);
        }
      });
    for (const role of ['br_rankings', 'br_ranking_rules', 'br_rebuild'])
      await expect(setRole(role)).rejects.toMatchObject(DENIED);
    const { rows: members } = await sql<{ role: string }>`
      SELECT r.rolname AS role FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member WHERE u.rolname = 'br_api' AND r.rolname LIKE 'br_rank%'`.execute(
      owner,
    );
    expect(members.map((m) => m.role)).toEqual(['br_ranking_staff_reader']);
    const { rows: flags } = await sql<{
      login: boolean;
      inherit: boolean;
      set: boolean;
      admin: boolean;
    }>`
      SELECT r.rolcanlogin AS login, m.inherit_option AS inherit, m.set_option AS set, m.admin_option AS admin
      FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
      WHERE u.rolname = 'br_api' AND r.rolname = 'br_ranking_staff_reader'`.execute(owner);
    expect(flags).toEqual([{ login: false, inherit: false, set: true, admin: false }]);
    // Only br_api may become it.
    const { rows: holders } = await sql<{ u: string }>`
      SELECT u.rolname AS u FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member WHERE r.rolname = 'br_ranking_staff_reader'`.execute(
      owner,
    );
    expect(holders.map((h) => h.u)).toEqual(['br_api']);

    // Exactly SELECT on run_card / run_candidate; nothing else anywhere.
    const { rows: grants } = await sql<{ t: string; p: string }>`
      SELECT table_schema || '.' || table_name AS t, privilege_type AS p FROM information_schema.role_table_grants
      WHERE grantee = 'br_ranking_staff_reader' ORDER BY 1, 2`.execute(owner);
    expect(grants).toEqual([
      { t: 'ranking_read.run_candidate', p: 'SELECT' },
      { t: 'ranking_read.run_card', p: 'SELECT' },
    ]);
    const { rows: colGrants } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.column_privileges
      WHERE grantee = 'br_ranking_staff_reader' AND table_name NOT IN ('run_card', 'run_candidate')`.execute(
      owner,
    );
    expect(colGrants[0]?.n).toBe('0');
    const { rows: fns } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.role_routine_grants
      WHERE grantee = 'br_ranking_staff_reader'`.execute(owner);
    expect(fns[0]?.n).toBe('0');
    for (const stmt of [
      `INSERT INTO ranking_read.run_card (run_id) VALUES ('${newId()}')`,
      `UPDATE ranking_read.run_candidate SET state = 'INCLUDED'`,
      `DELETE FROM ranking_read.run_card`,
      `TRUNCATE ranking_read.run_candidate`,
      `SELECT 1 FROM ranking.run`,
      `SELECT 1 FROM ranking.snapshot`,
      `SELECT 1 FROM ranking_read.snapshot_card`,
      `SELECT 1 FROM results.result_version`,
      `INSERT INTO ranking.run (id) VALUES ('${newId()}')`,
    ])
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`SET LOCAL ROLE br_ranking_staff_reader`.execute(trx);
          await sql.raw(stmt).execute(trx);
        }),
        stmt,
      ).rejects.toMatchObject(DENIED);
    // …while its two SELECTs work (the role is usable, so the refusals above are real).
    await db.transaction().execute(async (trx) => {
      await sql`SET LOCAL ROLE br_ranking_staff_reader`.execute(trx);
      await sql`SELECT count(*) FROM ranking_read.run_card`.execute(trx);
      await sql`SELECT count(*) FROM ranking_read.run_candidate`.execute(trx);
    });
    // Without the dedicated role, br_api cannot read run projections from any of its other roles.
    for (const role of [
      ModuleRole.publicRead,
      ModuleRole.results,
      ModuleRole.achievements,
      ModuleRole.verificationReader,
      ModuleRole.records,
    ])
      await expect(
        inTransaction(db, role, (ctx) =>
          sql`SELECT 1 FROM ranking_read.run_candidate`.execute(ctx.trx),
        ),
        role,
      ).rejects.toMatchObject(DENIED);
    // br_api reaches no canonical ranking write through any role.
    for (const role of Object.values(ModuleRole).filter((r) =>
      [
        'br_public_read',
        'br_results',
        'br_achievements',
        'br_records',
        'br_verification_reader',
        'br_ranking_staff_reader',
      ].includes(r),
    ))
      for (const t of [
        'ranking.run',
        'ranking.snapshot',
        'ranking.snapshot_entry',
        'ranking.system_version',
      ])
        expect(
          (
            await sql<{
              ok: boolean;
            }>`SELECT has_table_privilege(${role}, ${t}, 'INSERT') AS ok`.execute(owner)
          ).rows[0]?.ok,
          `${role} INSERT ${t}`,
        ).toBe(false);
    const { rows: pub } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.role_table_grants
      WHERE grantee = 'PUBLIC' AND table_schema IN ('ranking', 'ranking_read')`.execute(owner);
    expect(pub[0]?.n).toBe('0');
    const { rows: definer } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'ranking_read'`.execute(owner);
    expect(definer[0]?.n).toBe('0');
  });

  it('QUALIFIED stays an Achievement: the existing public Achievement route is the only surface', async () => {
    expect(app.v1Routes.some((r) => r.url === '/v1/achievements/:achievementId')).toBe(true);
    for (const path of ['approve', 'create', 'issue', 'publish'])
      expect((await call('POST', `/v1/qualifications/${path}`, opH, {})).status).toBe(404);
    const { rows } = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM achievement.achievement WHERE achievement_type = 'QUALIFIED'`.execute(
      owner,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('leak scan: public bodies carry no topology, ids of accounts / runs / evidence, roles, SQL or staleDigest', () => {
    const pub = publicBodies.join('\n');
    expect(pub).not.toMatch(
      /staleDigest|evidenceCommitment|verificationRunId|"basis"|derivedFrom|pinned|accountId|ownerPrincipal|anchorId|"runId"|runInputHash|runOutcomeHash|"provenance":"(CANONICAL_ASSEMBLY|REFERENCE_FIXTURE)"/,
    );
    expect(pub).not.toContain(runId);
    expect(pub).not.toContain(organizer.ownerAccountId);
    for (const text of [pub, staffBodies.join('\n'), logLines.join('\n')])
      expect(text).not.toMatch(
        /\bbr_[a-z_]+\b|SELECT |INSERT INTO|ranking_read\.|pg_|\b42501\b|duplicate key/,
      );
  });
});

// ═════════════════════════════ REFERENCE FIXTURE lane (br_rkfx_*) ═════════════════════════════

describe('BRT-10 /v1 rankings — REFERENCE FIXTURE lane (throwaway br_rkfx_; NOT SPORTING TRUTH)', () => {
  let fx: RankingFixtureDatabase;
  const fdbs: Db[] = [];
  let fowner: Db;
  let fmaint: Db;
  let fixtureApp: FastifyInstance;
  let productionApp: ReturnType<typeof buildServer>;
  let systemId: string;
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
    fmaint = mk(urls.maintenance);
    const fw = mk(rankingWorkerDatabaseUrl(fx.database));
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
      code: `rk-fx-${tag}`,
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
          discipline: { disciplineVersionId: dv, sport: codes.sport, discipline: codes.discipline },
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
    snaps.a = await publish(
      [cand(1, 1, '900000'), cand(2, 2, '900000'), cand(3, 3, '905000')],
      120,
    );
    snaps.b = await publish([cand(1, 1, '900000'), cand(2, 2, '901000')], 130);
    snaps.c = await publish([cand(2, 2, '901000')], 140, snaps.b);
    snaps.d = await publish([cand(2, 2, '902000')], 150, snaps.c);
    snaps.e = await publish([cand(2, 2, '902000'), cand(3, 3, '903000')], 160);

    // The production server against this database: the canonical-only reader.
    productionApp = buildServer({
      db: fapi,
      auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
    });
    // The same /v1 routes with the lane reader (test harness only).
    fixtureApp = Fastify({
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
    });
    fixtureApp.setErrorHandler((err, _request, reply) => {
      if (err instanceof DomainError) {
        const { status, body } = errorBody(err);
        return reply.code(status).send(body);
      }
      const e = err as { validation?: unknown; message?: string };
      if (e.validation !== undefined)
        return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: e.message } });
      return reply.code(500).send({ error: { code: 'INTERNAL', message: 'internal error' } });
    });
    registerV1(fixtureApp, {
      auth: createDevTokenAuth(fidentity, { secret: SECRET }),
      identity: fidentity,
      organizations: new OrganizationStore(fapi),
      passports: new PassportReader(fapi),
      organizationReader: new OrganizationReader(fapi),
      rankings: {
        publicReader: rankingFixturePublicReader(fapi),
        staffReader: new RankingStaffReader(fapi),
      },
    });
    await fixtureApp.ready();
  }, 300_000);
  afterAll(async () => {
    await Promise.all([fixtureApp.close(), productionApp.close()]);
    await Promise.all(fdbs.map((d) => d.destroy()));
    await fx.destroy();
  }, 60_000);

  const fget = (url: string) => call('GET', url, {}, undefined, fixtureApp);

  it('fixture snapshots are never public through the production reader', async () => {
    for (const view of ['as-published', 'as-corrected']) {
      const r = await call(
        'GET',
        `/v1/ranking-systems/${systemId}/snapshots?view=${view}`,
        {},
        undefined,
        productionApp,
      );
      expect(r.json.items).toEqual([]);
    }
    for (const id of Object.values(snaps)) {
      expect(
        (await call('GET', `/v1/ranking-snapshots/${id}`, {}, undefined, productionApp)).status,
      ).toBe(404);
      expect(
        (await call('GET', `/v1/ranking-snapshots/${id}/leaderboard`, {}, undefined, productionApp))
          .status,
      ).toBe(404);
    }
  });

  it('as-published keeps every snapshot in chain order with correctedBy; nothing hidden or rewritten', async () => {
    const r = await fget(`/v1/ranking-systems/${systemId}/snapshots?view=as-published`);
    expect(r.status).toBe(200);
    const items = r.json.items as { snapshotId: string; lineage: Record<string, unknown> }[];
    expect(items.map((i) => i.snapshotId)).toEqual([snaps.a, snaps.b, snaps.c, snaps.d, snaps.e]);
    expect(items.map((i) => i.lineage.kind)).toEqual([
      'INITIAL',
      'FOLLOWS',
      'CORRECTS',
      'CORRECTS',
      'FOLLOWS',
    ]);
    expect(items.map((i) => i.lineage.chainPosition)).toEqual([1, 2, 3, 4, 5]);
    expect(items.map((i) => i.lineage.correctedBy)).toEqual([
      undefined,
      snaps.c,
      snaps.d,
      undefined,
      undefined,
    ]);
    expect(items[2]?.lineage).toMatchObject({
      priorSnapshotId: snaps.b,
      reasons: ['RESULT_SUPERSEDED'],
    });
    const { rows } = await sql<{ id: string; h: string }>`
      SELECT id::text AS id, snapshot_hash AS h FROM ranking.snapshot ORDER BY recorded_at, id`.execute(
      fowner,
    );
    expect(
      items.map((i) => [i.snapshotId, (i as unknown as { snapshotHash: string }).snapshotHash]),
    ).toEqual(rows.map((x) => [x.id, x.h]));
    for (const i of items) expect(forbiddenMembers(i)).toEqual([]);
  });

  it('as-corrected replaces corrected snapshots by their final correction, which lists what it corrects', async () => {
    const r = await fget(`/v1/ranking-systems/${systemId}/snapshots?view=as-corrected`);
    expect(r.json.items.map((i: { snapshotId: string }) => i.snapshotId)).toEqual([
      snaps.a,
      snaps.d,
      snaps.e,
    ]);
    expect(r.json.items[1].corrects).toEqual([snaps.b, snaps.c]);
    // Bounded pages walk the same view.
    const p1 = await fget(`/v1/ranking-systems/${systemId}/snapshots?view=as-corrected&limit=2`);
    const p2 = await fget(
      `/v1/ranking-systems/${systemId}/snapshots?view=as-corrected&limit=2&cursor=${p1.json.nextCursor}`,
    );
    expect(
      [...p1.json.items, ...p2.json.items].map((i: { snapshotId: string }) => i.snapshotId),
    ).toEqual([snaps.a, snaps.d, snaps.e]);
    expect(p2.json.nextCursor).toBeUndefined();
  });

  it('snapshot detail: immutable facts + read-time STALE (synthetic pins unknown), affected pins omitted', async () => {
    const r = await fget(`/v1/ranking-snapshots/${snaps.a}`);
    expect(r.status).toBe(200);
    expect(r.json.schema).toBe('br:public-ranking-snapshot@1');
    expect(r.json.snapshot).toMatchObject({
      snapshotId: snaps.a,
      kind: 'PLATFORM',
      label: 'Bragging Rights platform ranking',
      entryCount: 3,
      lineage: { kind: 'INITIAL', chainPosition: 1 },
    });
    expect(r.json.readTime).toEqual({
      staleness: {
        state: 'STALE',
        reasons: ['BASIS_RESULT_NOT_CURRENT', 'BASIS_VERIFICATION_NOT_CURRENT'],
      },
    });
    expect(forbiddenMembers(r.json)).toEqual([]);
    const { rows } = await sql<{
      content: { entries: { basis: { resultVersionId: string; verificationRunId: string }[] }[] };
    }>`
      SELECT content FROM ranking.snapshot WHERE id = ${snaps.a}`.execute(fowner);
    for (const e of rows[0]?.content.entries ?? [])
      for (const b of e.basis) {
        expect(r.text).not.toContain(b.resultVersionId);
        expect(r.text).not.toContain(b.verificationRunId);
      }
  });

  it('leaderboard: canonical rank order with shared ties, exact values, basisCount; private holders never named', async () => {
    const r = await fget(`/v1/ranking-snapshots/${snaps.a}/leaderboard`);
    expect(r.status).toBe(200);
    expect(r.json.entries.map((e: { rank: number; tied: boolean }) => [e.rank, e.tied])).toEqual([
      [1, true],
      [1, true],
      [3, false],
    ]);
    expect(r.json.entries[0]).toMatchObject({
      value: { value: '900000', display: expect.stringMatching(/^900000 /) },
      comparatorTrace: [{ key: 'elapsedTimeMs', order: 'LOWER_IS_BETTER', value: '900000' }],
      basisCount: 1,
      holder: { holderType: 'ATHLETE', display: { kind: 'PRIVATE_ENTRANT' } },
    });
    expect(forbiddenMembers(r.json)).toEqual([]);
    const p1 = await fget(`/v1/ranking-snapshots/${snaps.a}/leaderboard?limit=1`);
    const p2 = await fget(
      `/v1/ranking-snapshots/${snaps.a}/leaderboard?limit=2&cursor=${p1.json.nextCursor}`,
    );
    expect([...p1.json.entries, ...p2.json.entries]).toEqual(r.json.entries);
    expect(p2.json.nextCursor).toBeUndefined();
    expect(
      (
        await fget(
          `/v1/ranking-snapshots/${snaps.a}/leaderboard?cursor=${Buffer.from('1|ATHLETE|x').toString('base64url')}`,
        )
      ).status,
    ).toBe(400);
  });

  it('corrupted snapshot / leaderboard projections fail closed (PROJECTION_MISMATCH); rebuild restores', async () => {
    const mismatch = errorVector('error/projection-mismatch');
    await sql`UPDATE ranking_read.leaderboard_entry SET rank = 2 WHERE snapshot_id = ${snaps.e} AND rank = 1`.execute(
      fowner,
    );
    expect(await fget(`/v1/ranking-snapshots/${snaps.e}/leaderboard`)).toMatchObject({
      status: mismatch.status,
      json: mismatch.body,
    });
    await sql`UPDATE ranking_read.snapshot_card SET snapshot_hash = ${`sha256:${'7'.repeat(64)}`}
              WHERE snapshot_id = ${snaps.e}`.execute(fowner);
    expect(await fget(`/v1/ranking-snapshots/${snaps.e}`)).toMatchObject({
      status: mismatch.status,
      json: mismatch.body,
    });
    await rebuildRankingReadModels(fmaint);
    expect((await fget(`/v1/ranking-snapshots/${snaps.e}`)).status).toBe(200);
    expect((await fget(`/v1/ranking-snapshots/${snaps.e}/leaderboard`)).status).toBe(200);
  });
});
