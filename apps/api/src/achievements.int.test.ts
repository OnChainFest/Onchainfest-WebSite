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
  VerificationPolicyStore,
} from '@br/persistence';
import {
  apiDb,
  declaredNoParticipation,
  newContestResult,
  operatorDb,
  ownerDb,
  personSigner,
  publishPolicy,
  seedTestCatalog,
  uniqueSlug,
  vaultDb,
  verificationOperatorDb,
  type TestCatalog,
} from '@br/testkit';
import { achievementOperatorDb } from '@br/testkit/achievements';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

/**
 * BRT-08 through the real /v1 surface (CANONICAL PRODUCTION lane): rule administration on the
 * dedicated operator connection, staff-requested canonical derivation (honestly zero Achievements
 * today), closed request schemas (no manual award path), public DTOs and the Passport section — with
 * literal sentinels that must never leak. ALL DATA IS FICTIONAL.
 */
const SECRET = `achievement-int-auth-secret-${newId()}`;
const AUD = 'bragging-rights:test';
const tag = newId().replace(/-/g, '').slice(-10);
const S = {
  legalName: `Sentinel Legal A${tag}`,
  dateOfBirth: '1907-03-03',
  email: `sentinel.a${tag}@example.test`,
  phone: `+1555${tag.replace(/[a-f]/g, '8').slice(0, 7)}`,
  authSubject: `auth-subject-a${tag}`,
};
const logLines: string[] = [];
const db = apiDb();
const vault = vaultDb();
const owner = ownerDb();
const catalogOperator = operatorDb();
const vop = verificationOperatorDb();
const aop = achievementOperatorDb();
const app = buildServer({
  db,
  vaultDb: vault,
  achievementOperatorDb: aop,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: `achievement-int-vault-${newId()}` }),
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
  await Promise.all([db, vault, owner, catalogOperator, vop, aop].map((d) => d.destroy()));
});

const bearer = (sub: string, operator = false) => ({
  authorization: `Bearer ${mintDevToken(sub, { secret: SECRET, operator })}`,
});
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
const strangerH = bearer(`stranger-a${tag}`);
const opH = bearer(`operator-a${tag}`, true);
let catalog: TestCatalog;
let w: Awaited<ReturnType<typeof newContestResult>>;
let ruleCode: string;

beforeAll(async () => {
  const orgAccountId = (await call('GET', '/v1/me', orgH)).json.accountId;
  const personId = (await call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' }))
    .json.personId;
  await call('PUT', `/v1/persons/${personId}/private`, orgH, {
    legalName: S.legalName,
    dateOfBirth: S.dateOfBirth,
    email: S.email,
    phone: S.phone,
  });
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...orgH, ...idem() },
    {
      orgType: 'CLUB',
      slug: uniqueSlug('aorg'),
      profile: { displayName: 'Fictional Achievement Club' },
    },
  );
  const identity = new IdentityStore(db);
  catalog = await seedTestCatalog(identity, new CatalogStore(catalogOperator));
  await publishPolicy(
    new VerificationPolicyStore(vop),
    catalog.operatorAccountId,
    catalog.tennisSingles,
  );
  // A rule through the INTERNAL API, bound BEFORE the result is submitted.
  ruleCode = `api-win-${tag}`;
  const r = await call(
    'POST',
    '/v1/internal/achievement-rules',
    { ...opH, ...idem() },
    { code: ruleCode, name: 'Fictional API match-winner rule', achievementType: 'CONTEST_WON' },
  );
  const v = await call(
    'POST',
    `/v1/internal/achievement-rules/${r.json.ruleId}/versions`,
    { ...opH, ...idem() },
    {
      spec: {
        targetEngine: 'achievement-engine/1',
        achievementType: 'CONTEST_WON',
        displayName: 'Match Winner',
        disciplineVersionId: catalog.tennisSingles,
        holder: 'ENTRY_PARTICIPANT',
        requirements: { minimumVerificationLevel: 'V2', minimumResultStatus: 'FINAL' },
        criterion: { kind: 'CONTEST_OUTCOME', resultScope: 'CONTEST', outcomes: ['WIN'] },
      },
    },
  );
  await call(
    'POST',
    `/v1/internal/achievement-rule-versions/${v.json.ruleVersionId}/publish`,
    opH,
    {},
  );
  await call(
    'POST',
    `/v1/internal/achievement-rule-versions/${v.json.ruleVersionId}/bindings`,
    { ...opH, ...idem() },
    {},
  );
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
  const B = await personSigner(
    {
      db,
      ceremony: new PrincipalKeyCeremony(db, { audience: AUD }),
      attestations: new AttestationStore(db, { audience: AUD }),
    },
    w.athletes[1]!,
  );
  for (let i = 1; ; i++) {
    try {
      await B.attest(w.resultVersionId, { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' });
      break;
    } catch (err) {
      if ((err as { code?: string }).code !== 'KEY_NOT_VALID' || i >= 4) throw err;
      await new Promise((res) => setTimeout(res, 1200));
    }
  }
  await call('POST', `/v1/result-versions/${w.resultVersionId}/verification-runs`, orgH, {});
});

describe('BRT-08 /v1 rule administration (INTERNAL, dedicated operator connection)', () => {
  it('403 non-operator, 401 forged/missing, 503 without the operator connection (no fallback)', async () => {
    const body = { code: `x-${tag}`, name: 'x', achievementType: 'TITLE' };
    expect(
      (await call('POST', '/v1/internal/achievement-rules', { ...orgH, ...idem() }, body)).status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          '/v1/internal/achievement-rules',
          { authorization: 'Bearer forged.token.x', ...idem() },
          body,
        )
      ).status,
    ).toBe(401);
    expect((await call('POST', '/v1/internal/achievement-rules', idem(), body)).status).toBe(401);
    expect(
      await call('POST', '/v1/internal/achievement-rules', { ...opH, ...idem() }, body, noOperator),
    ).toMatchObject({
      status: 503,
      json: { error: { code: 'INTERNAL_CAPABILITY_UNAVAILABLE' } },
    });
  });

  it('strict schemas: unknown fields, scripts and below-floor specs are rejected with fixed issue codes', async () => {
    const r = await call(
      'POST',
      '/v1/internal/achievement-rules',
      { ...opH, ...idem() },
      { code: `f-${tag}`, name: 'floor', achievementType: 'TITLE' },
    );
    const bad = await call(
      'POST',
      `/v1/internal/achievement-rules/${r.json.ruleId}/versions`,
      { ...opH, ...idem() },
      {
        spec: {
          targetEngine: 'achievement-engine/1',
          achievementType: 'TITLE',
          displayName: 'National Champion',
          disciplineVersionId: catalog.tennisSingles,
          holder: 'ENTRY_PARTICIPANT',
          requirements: { minimumVerificationLevel: 'V1', minimumResultStatus: 'FINAL' },
          criterion: {
            kind: 'CLASSIFICATION_POSITION',
            resultScope: 'EVENT_CLASSIFICATION',
            rank: { min: 1, max: 1 },
          },
        },
      },
    );
    expect(bad.status).toBe(400);
    const codes = (bad.json.error.issues as { code: string }[]).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['BELOW_PLATFORM_FLOOR', 'DISPLAY_NAME_CLAIMS_RECOGNITION']),
    );
    expect(
      (
        await call(
          'POST',
          `/v1/internal/achievement-rules/${r.json.ruleId}/versions`,
          { ...opH, ...idem() },
          { spec: {}, eval: 'x' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/v1/internal/achievement-rules',
          { ...opH, ...idem() },
          { code: `g-${tag}`, name: 'g', achievementType: 'WORLD_RECORD' },
        )
      ).status,
    ).toBe(400);
  });

  it('published rule is public (declarative spec, no author identity)', async () => {
    const r = await call('GET', `/v1/achievement-rules/${ruleCode}`);
    expect(r.status).toBe(200);
    expect(r.json.versions[0]).toMatchObject({ version: 1, status: 'PUBLISHED' });
    expect(r.text).not.toMatch(/created_by|account/i);
  });
});

describe('BRT-08 canonical derivation through the API (honest zero)', () => {
  it('staff request: the rule matches the facts but V1 / SUBMITTED / no hold facts ⇒ zero Achievements', async () => {
    const r = await call(
      'POST',
      `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
      orgH,
      {},
    );
    expect(r.status).toBe(200);
    const mine = (
      r.json.rules as {
        ruleCode: string;
        state: string;
        blockedBy: string[];
        wouldQualify: number;
        achievements: unknown[];
      }[]
    ).find((x) => x.ruleCode === ruleCode);
    expect(mine).toMatchObject({ state: 'BLOCKED', wouldQualify: 1, achievements: [] });
    expect(mine?.blockedBy).toEqual(
      expect.arrayContaining([
        'VERIFICATION_LEVEL_BELOW_REQUIRED',
        'RESULT_STATUS_BELOW_REQUIRED',
        'HOLD_STATE_UNAVAILABLE',
      ]),
    );
    const { rows } = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM achievement.achievement WHERE competition_id = ${w.competitionId}`.execute(
      owner,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('no manual override: holder / type / qualifyingValue / level / force / override inputs are rejected', async () => {
    for (const body of [
      { achievementType: 'TITLE' },
      { holderId: newId() },
      { qualifyingValue: '300' },
      { desiredVerificationLevel: 'V2' },
      { force: true },
      { override: true },
    ])
      expect(
        (
          await call(
            'POST',
            `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
            orgH,
            body,
          )
        ).status,
      ).toBe(400);
    expect((await call('POST', '/v1/achievements', opH, { achievementType: 'TITLE' })).status).toBe(
      404,
    );
    expect((await call('POST', `/v1/achievements/${newId()}`, opH, {})).status).toBe(404);
  });

  it('auth boundaries: 401 anonymous, 404 for non-staff (same as unknown ids)', async () => {
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
          {},
          {},
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await call(
          'POST',
          `/v1/result-versions/${w.resultVersionId}/achievement-derivations`,
          strangerH,
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (await call('POST', `/v1/result-versions/${newId()}/achievement-derivations`, orgH, {}))
        .status,
    ).toBe(404);
  });

  it('dependency index and public reads: nothing depends on this version; unknown achievement → 404', async () => {
    const d = await call(
      'GET',
      `/v1/result-versions/${w.resultVersionId}/achievement-dependents`,
      orgH,
    );
    expect(d.json).toEqual({ schema: 'br:achievement-dependents@1', dependents: [] });
    expect((await call('GET', `/v1/achievements/${newId()}`)).status).toBe(404);
    expect((await call('GET', '/v1/achievements/not-a-uuid')).status).toBe(400);
  });
});

describe('Passport Verified Achievements section and privacy', () => {
  it('the athlete section is backed by the read model (AVAILABLE, none) and leaks nothing private', async () => {
    const slug = w.athletes[0]!.slug;
    const r = await call('GET', `/v1/athletes/${slug}/achievements`);
    expect(r.status).toBe(200);
    expect(r.json.verifiedAchievements).toEqual({ status: 'AVAILABLE', items: [] });
    const passport = await call('GET', `/v1/athletes/${slug}`);
    expect(passport.json.passport.verifiedAchievements).toEqual({ status: 'AVAILABLE', items: [] });
  });

  it('sentinels never appear in responses, logs, outbox or audit', async () => {
    const { rows: outbox } = await sql<{
      payload: unknown;
    }>`SELECT payload FROM platform.outbox_event WHERE event_type LIKE 'Achievement%'`.execute(
      owner,
    );
    const { rows: audit } = await sql<{
      details: unknown;
    }>`SELECT details FROM platform.audit_event WHERE action LIKE 'achievement.%'`.execute(owner);
    const blob = JSON.stringify({ outbox, audit, logLines });
    for (const value of Object.values(S)) expect(blob).not.toContain(value);
    expect(blob).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
  });
});
