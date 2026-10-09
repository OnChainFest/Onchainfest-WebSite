import { newId } from '@br/domain';
import { createDevelopmentPiiCipher } from '@br/identity';
import {
  AttestationStore,
  AuthorityStore,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  createCompetitionResultLedger,
  IdentityStore,
  OrganizationStore,
  PrincipalKeyCeremony,
  StructureStore,
} from '@br/persistence';
import {
  apiDb,
  awaitDbTimePast,
  declaredNoParticipation,
  newContestResult,
  operatorDb,
  ownerDb,
  personSigner,
  seedTestCatalog,
  uniqueSlug,
  vaultDb,
  verificationOperatorDb,
  type TestCatalog,
} from '@br/testkit';
import { REFERENCE_POLICY_SPEC } from '@br/verification';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

/**
 * BRT-07 through the real /v1 surface: policy administration on the dedicated operator connection,
 * staff-triggered evaluation, public current verification with hash-based freshness, public run
 * summaries, historical replay — with literal sentinels that must never leak. ALL DATA IS FICTIONAL.
 */
const SECRET = `verification-int-auth-secret-${newId()}`;
const VAULT_KEY = `verification-int-vault-key-${newId()}`;
const AUD = 'bragging-rights:test';
const tag = newId().replace(/-/g, '').slice(-10);
const S = {
  legalName: `Sentinel Legal V${tag}`,
  dateOfBirth: '1908-02-29',
  email: `sentinel.v${tag}@example.test`,
  phone: `+1555${tag.replace(/[a-f]/g, '7').slice(0, 7)}`,
  authSubject: `auth-subject-v${tag}`,
};
const logLines: string[] = [];
const db = apiDb();
const vault = vaultDb();
const owner = ownerDb();
const catalogOperator = operatorDb();
const vop = verificationOperatorDb();
const app = buildServer({
  db,
  vaultDb: vault,
  verificationOperatorDb: vop,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: VAULT_KEY }),
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  signatureAudience: AUD,
  logStream: { write: (line: string) => void logLines.push(line) },
});
const noOperator = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  signatureAudience: AUD,
});
afterAll(async () => {
  await Promise.all([app.close(), noOperator.close()]);
  await Promise.all([db, vault, owner, catalogOperator, vop].map((d) => d.destroy()));
});

const tokens: string[] = [];
const bearer = (sub: string, operator = false) => {
  const t = mintDevToken(sub, { secret: SECRET, operator });
  tokens.push(t);
  return { authorization: `Bearer ${t}` };
};
const idem = () => ({ 'idempotency-key': `k-${newId()}` });
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
  server = app,
) {
  const res = await server.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    text: res.body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON navigation in tests
    json: (res.headers['content-type']?.toString().includes('json') ? res.json() : null) as any,
  };
}

const orgH = bearer(S.authSubject);
const strangerH = bearer(`stranger-v${tag}`);
const opH = bearer(`operator-v${tag}`, true);
let w: Awaited<ReturnType<typeof newContestResult>>;
let catalog: TestCatalog;
let personId: string;
let orgAccountId: string;
let B: Awaited<ReturnType<typeof personSigner>>;

beforeAll(async () => {
  orgAccountId = (await call('GET', '/v1/me', orgH)).json.accountId;
  personId = (await call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' })).json
    .personId;
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...orgH, ...idem() },
    {
      orgType: 'CLUB',
      slug: uniqueSlug('vorg'),
      profile: { displayName: 'Fictional Verification Club' },
    },
  );
  await call('PUT', `/v1/persons/${personId}/private`, orgH, {
    legalName: S.legalName,
    dateOfBirth: S.dateOfBirth,
    email: S.email,
    phone: S.phone,
  });
  const identity = new IdentityStore(db);
  catalog = await seedTestCatalog(identity, new CatalogStore(catalogOperator));
  w = await newContestResult({
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority: new AuthorityStore(db, { conflictChecker: declaredNoParticipation }),
    ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog,
    submitAs: 'ATHLETE_A',
    organizer: {
      ownerAccountId: orgAccountId,
      ownerPersonId: personId,
      organizationId: org.json.organizationId,
      slug: org.json.slug,
    },
  });
  B = await personSigner(
    {
      db,
      ceremony: new PrincipalKeyCeremony(db, { audience: AUD }),
      attestations: new AttestationStore(db, { audience: AUD }),
    },
    w.athletes[1]!,
  );
});

describe('BRT-07 /v1 policy administration (INTERNAL, dedicated operator connection)', () => {
  let policyVersionId: string;
  it('non-operators get 403 (audited); without the operator connection → 503 (no fallback)', async () => {
    const body = { code: `api-${tag}`, name: 'Fictional API policy' };
    expect(
      (await call('POST', '/v1/internal/verification-policies', { ...orgH, ...idem() }, body))
        .status,
    ).toBe(403);
    expect((await call('POST', '/v1/internal/verification-policies', idem(), body)).status).toBe(
      401,
    );
    const r = await call(
      'POST',
      '/v1/internal/verification-policies',
      { ...opH, ...idem() },
      body,
      noOperator,
    );
    expect(r).toMatchObject({
      status: 503,
      json: { error: { code: 'INTERNAL_CAPABILITY_UNAVAILABLE' } },
    });
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'verification.policy-create-denied' AND outcome = 'DENIED' AND actor_account_id = ${orgAccountId}`.execute(
      owner,
    );
    expect(rows[0]!.n).toBeGreaterThan(0);
  });

  it('operator creates, versions (validated), publishes and binds to an exact DisciplineVersion', async () => {
    const p = await call(
      'POST',
      '/v1/internal/verification-policies',
      { ...opH, ...idem() },
      { code: `api-${tag}`, name: 'Fictional API policy' },
    );
    expect(p.status).toBe(201);
    const bad = await call(
      'POST',
      `/v1/internal/verification-policies/${p.json.policyId}/versions`,
      { ...opH, ...idem() },
      {
        spec: { ...REFERENCE_POLICY_SPEC, script: 'return true' },
      },
    );
    expect(bad).toMatchObject({
      status: 400,
      json: { error: { code: 'INVALID_INPUT', issues: [{ code: 'BRJ_UNKNOWN_FIELD' }] } },
    });
    const v = await call(
      'POST',
      `/v1/internal/verification-policies/${p.json.policyId}/versions`,
      { ...opH, ...idem() },
      { spec: REFERENCE_POLICY_SPEC },
    );
    expect(v).toMatchObject({ status: 201, json: { version: 1 } });
    policyVersionId = v.json.policyVersionId;
    const draftBind = await call(
      'POST',
      `/v1/internal/discipline-versions/${catalog.tennisSingles}/verification-policy-bindings`,
      { ...opH, ...idem() },
      { policyVersionId },
    );
    expect(draftBind.json.error.code).toBe('INVALID_TRANSITION');
    expect(
      (
        await call(
          'POST',
          `/v1/internal/verification-policy-versions/${policyVersionId}/publish`,
          opH,
          {},
        )
      ).json,
    ).toMatchObject({ status: 'PUBLISHED', changed: true });
    const backdated = await call(
      'POST',
      `/v1/internal/discipline-versions/${catalog.tennisSingles}/verification-policy-bindings`,
      { ...opH, ...idem() },
      {
        policyVersionId,
        effectiveFrom: '2001-01-01T00:00:00Z',
      },
    );
    expect(backdated.json.error.code).toBe('BACKDATING_REJECTED');
    const b = await call(
      'POST',
      `/v1/internal/discipline-versions/${catalog.tennisSingles}/verification-policy-bindings`,
      { ...opH, ...idem() },
      { policyVersionId },
    );
    expect(b.status).toBe(201);
    const pub = await call('GET', `/v1/verification-policies/api-${tag}`);
    expect(pub.json).toMatchObject({
      code: `api-${tag}`,
      versions: [{ version: 1, status: 'PUBLISHED' }],
    });
  });
});

describe('BRT-07 /v1 evaluation and public verification', () => {
  let firstRunId: string;
  it('public current: NOT_EVALUATED before any run; staff-only evaluation; closed request schema', async () => {
    const cur = await call('GET', `/v1/result-versions/${w.resultVersionId}/verification`);
    expect(cur.json).toMatchObject({
      schema: 'br:public-verification@1',
      freshness: 'NOT_EVALUATED',
      evaluationState: 'NOT_EVALUATED',
    });
    const url = `/v1/result-versions/${w.resultVersionId}/verification-runs`;
    expect((await call('POST', url, {}, {})).status).toBe(401);
    expect(
      (await call('POST', url, { authorization: 'Bearer brdev.forged.token' }, {})).status,
    ).toBe(401);
    expect((await call('POST', url, strangerH, {})).status).toBe(404);
    for (const override of [
      { desiredLevel: 'V4' },
      { forceLevel: 'V3' },
      { manualOverride: true },
      { confidence: 0.9 },
      { ignoreConflict: true },
    ])
      expect((await call('POST', url, orgH, override)).status).toBe(400);
    const r = await call('POST', url, orgH, {});
    expect(r).toMatchObject({
      status: 201,
      json: { highestSatisfiedLevel: 'V0', label: 'Claimed', evaluationState: 'EVALUATED' },
    });
    firstRunId = r.json.runId;
    const again = await call('POST', url, orgH, {});
    expect(again).toMatchObject({ status: 200, json: { runId: firstRunId, created: false } });
  });

  it('new corroboration stales the run; re-evaluation reaches V1; V2 is honestly blocked', async () => {
    await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
    const stale = (await call('GET', `/v1/result-versions/${w.resultVersionId}/verification`)).json;
    expect(stale).toMatchObject({
      freshness: 'STALE',
      reEvaluationRequired: true,
      lastEvaluated: { level: 'V0', label: 'Claimed' },
    });
    expect(stale.level).toBeUndefined();
    const r = await call(
      'POST',
      `/v1/result-versions/${w.resultVersionId}/verification-runs`,
      orgH,
      {},
    );
    expect(r).toMatchObject({
      status: 201,
      json: { highestSatisfiedLevel: 'V1', label: 'Corroborated' },
    });
    const cur = (await call('GET', `/v1/result-versions/${w.resultVersionId}/verification`)).json;
    expect(cur).toMatchObject({
      freshness: 'CURRENT',
      level: 'V1',
      label: 'Corroborated',
      reEvaluationRequired: false,
      next: { level: 'V2', label: 'Event Certified' },
    });
    expect(cur.statement).toMatch(
      /^Corroborated \(V1\): current canonical facts satisfy policy api-/,
    );
    expect(
      cur.next.blocked.find((x: { criterion: string }) => x.criterion === 'OFFICIAL_DECLARATION'),
    ).toMatchObject({ status: 'INPUT_NOT_SUPPORTED' });
    // historical, "as known then": before B's corroboration the claim was V0; nothing is persisted
    const first = (await call('GET', `/v1/verification-runs/${firstRunId}`, orgH)).json;
    await awaitDbTimePast(owner, first.evaluatedAsOf);
    const replay = await call(
      'POST',
      `/v1/result-versions/${w.resultVersionId}/verification-replays`,
      orgH,
      { asOf: first.evaluatedAsOf },
    );
    expect(replay.json).toMatchObject({
      kind: 'HISTORICAL',
      persisted: false,
      highestSatisfiedLevel: 'V0',
      matchingRunId: firstRunId,
    });
    expect(
      (
        await call('POST', `/v1/result-versions/${w.resultVersionId}/verification-replays`, orgH, {
          asOf: '2999-01-01T00:00:00Z',
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('GET', `/v1/result-versions/${w.resultVersionId}/verification-runs`, orgH)).json
        .runs,
    ).toHaveLength(2);
  });

  it('run detail (trace) is staff-only; the public run summary carries no trace or identities', async () => {
    expect((await call('GET', `/v1/verification-runs/${firstRunId}`, strangerH)).status).toBe(404);
    expect((await call('GET', `/v1/verification-runs/${firstRunId}`)).status).toBe(401);
    const detail = (await call('GET', `/v1/verification-runs/${firstRunId}`, orgH)).json;
    expect(detail).toMatchObject({
      freshness: 'STALE',
      trace: { engineVersion: 'verification-engine/1' },
    });
    const summary = await call('GET', `/v1/verification-runs/${firstRunId}/summary`);
    expect(summary.json).toMatchObject({
      schema: 'br:public-verification-run@1',
      historical: true,
      level: 'V0',
      label: 'Claimed',
    });
    expect(summary.text).not.toContain('trace');
    for (const id of [B.principalId, w.submitterPrincipalId, personId, orgAccountId])
      expect(summary.text.includes(id)).toBe(false);
  });
});

describe('privacy sentinels: verification surfaces leak nothing private', () => {
  it('public DTOs, outbox, audit, read models and logs are clean', async () => {
    const publicText = [
      (await call('GET', `/v1/result-versions/${w.resultVersionId}/verification`)).text,
      (await call('GET', `/v1/verification-policies/api-${tag}`)).text,
    ].join('\n');
    const dump = async (q: string) => JSON.stringify((await sql.raw(q).execute(owner)).rows);
    const surfaces: Record<string, string> = {
      public: publicText,
      outbox: await dump(
        `SELECT payload FROM platform.outbox_event WHERE event_type ~ '^(Verification|CurrentVerification)'`,
      ),
      audit: await dump(
        `SELECT details FROM platform.audit_event WHERE action ~ '^verification\\.'`,
      ),
      readModels:
        (await dump('SELECT * FROM verification_read.current_verification')) +
        (await dump('SELECT * FROM verification_read.run_summary')),
      logs: logLines.join('\n'),
    };
    const forbidden = [...Object.values(S), VAULT_KEY, SECRET, ...tokens];
    for (const [surface, text] of Object.entries(surfaces))
      for (const v of forbidden)
        expect(text.includes(v), `${surface} contains ${v.slice(0, 24)}…`).toBe(false);
    for (const id of [personId, orgAccountId, B.principalId, w.submitterPrincipalId, B.key.keyId])
      expect(publicText.includes(id), id).toBe(false);
    expect(publicText).not.toMatch(/"(confidence|trustScore|score|probability|weight)"\s*:/);
    expect(publicText).not.toContain('Verified ✓');
  });
});
