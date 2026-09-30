import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@br/domain';
import {
  createDevelopmentEvidenceCipher,
  createEphemeralSigner,
  FilesystemEvidenceBlobStore,
} from '@br/evidence';
import { createDevelopmentPiiCipher } from '@br/identity';
import {
  AuthorityStore,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  createCompetitionResultLedger,
  IdentityStore,
  OrganizationStore,
  StructureStore,
} from '@br/persistence';
import {
  apiDb,
  declaredNoParticipation,
  newContestResult,
  operatorDb,
  ownerDb,
  seedTestCatalog,
  uniqueSlug,
  vaultDb,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevTokenAuth, mintDevToken } from './auth';
import { buildServer } from './server';

/**
 * BRT-06 through the real /v1 surface: evidence upload/metadata/content, key onboarding,
 * attestation ceremony, retraction, public signed-claim cards and the Evidence Bundle — with
 * literal sentinels that must never leak into public DTOs, outbox, audit, idempotency, read models,
 * storage or logs. ALL DATA IS FICTIONAL.
 */
const SECRET = `evidence-int-auth-secret-${newId()}`;
const VAULT_KEY = `evidence-int-vault-key-${newId()}`;
const EVIDENCE_KEY = `evidence-int-evidence-key-${newId()}`;
const tag = newId().replace(/-/g, '').slice(-10);
const S = {
  legalName: `Sentinel Legal E${tag}`,
  dateOfBirth: '1904-02-29',
  email: `sentinel.e${tag}@example.test`,
  phone: `+1555${tag.replace(/[a-f]/g, '8').slice(0, 7)}`,
  evidenceContent: `EVIDENCE-PLAINTEXT-E${tag}`,
  externalId: `PRIVEXT-E${tag}`,
  authSubject: `auth-subject-e${tag}`,
};
const root = mkdtempSync(join(tmpdir(), 'br-evidence-api-'));
const logLines: string[] = [];
const db = apiDb();
const vault = vaultDb();
const owner = ownerDb();
const operator = operatorDb();
const blobStore = new FilesystemEvidenceBlobStore({
  root,
  cipher: createDevelopmentEvidenceCipher({ keyMaterial: EVIDENCE_KEY }),
});
const app = buildServer({
  db,
  vaultDb: vault,
  piiCipher: createDevelopmentPiiCipher({ keyMaterial: VAULT_KEY }),
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  evidenceBlobStore: blobStore,
  signatureAudience: 'bragging-rights:test',
  logStream: { write: (line: string) => void logLines.push(line) },
});
const noStorage = buildServer({
  db,
  auth: (identity: IdentityStore) => createDevTokenAuth(identity, { secret: SECRET }),
  signatureAudience: 'bragging-rights:test',
});
afterAll(async () => {
  await Promise.all([app.close(), noStorage.close()]);
  await Promise.all([db, vault, owner, operator].map((d) => d.destroy()));
});

const tokens: string[] = [];
const bearer = (sub: string) => {
  const t = mintDevToken(sub, { secret: SECRET });
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
    headers: res.headers,
    raw: res.rawPayload,
    text: res.body,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form JSON navigation in tests
    json: (res.headers['content-type']?.toString().includes('json') ? res.json() : null) as any,
  };
}

const orgH = bearer(S.authSubject);
const strangerH = bearer(`stranger-${tag}`);
let w: Awaited<ReturnType<typeof newContestResult>>;
let orgPrincipalId: string;
let personId: string;
const bytes = new TextEncoder().encode(
  JSON.stringify({ sheet: 'fictional 6-4 6-3', secret: S.evidenceContent }),
);

beforeAll(async () => {
  const me = await call('GET', '/v1/me', orgH);
  const accountId = me.json.accountId as string;
  personId = (await call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' })).json
    .personId;
  const org = await call(
    'POST',
    '/v1/organizations',
    { ...orgH, ...idem() },
    {
      orgType: 'CLUB',
      slug: uniqueSlug('evorg'),
      profile: { displayName: 'Fictional Evidence Club' },
    },
  );
  orgPrincipalId = org.json.principalId;
  await call('PUT', `/v1/persons/${personId}/private`, orgH, {
    legalName: S.legalName,
    dateOfBirth: S.dateOfBirth,
    email: S.email,
    phone: S.phone,
  });
  const identity = new IdentityStore(db);
  const deps = {
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority: new AuthorityStore(db, { conflictChecker: declaredNoParticipation }),
    ledger: createCompetitionResultLedger(db, { conflictChecker: declaredNoParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog: await seedTestCatalog(identity, new CatalogStore(operator)),
  };
  w = await newContestResult({
    ...deps,
    organizer: {
      ownerAccountId: accountId,
      ownerPersonId: personId,
      organizationId: org.json.organizationId,
      slug: org.json.slug,
    },
  });
});

const upload = (headers: Record<string, string>, over: Record<string, unknown> = {}) =>
  call(
    'POST',
    '/v1/evidence',
    { ...headers, ...idem() },
    {
      content: { base64: Buffer.from(bytes).toString('base64'), mediaType: 'application/json' },
      evidenceType: 'SIGNED_SCORESHEET',
      source: { kind: 'HUMAN', externalNamespace: 'fictional-scorer', externalId: S.externalId },
      attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'PRIMARY' },
      ...over,
    },
  );

describe('BRT-06 /v1 evidence', () => {
  it('upload computes the hash server-side; strict DTOs; unsafe types, oversize and production posture fail closed', async () => {
    const r = await upload(orgH);
    expect(r.status).toBe(201);
    expect(r.json.contentHash).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(r.text).not.toContain(root);
    expect((await upload(orgH, { contentHash: `sha256:${'0'.repeat(64)}` })).status).toBe(400); // client hash: unknown member
    expect(
      (
        await upload(orgH, {
          content: {
            base64: Buffer.from('<html></html>').toString('base64'),
            mediaType: 'text/html',
          },
        })
      ).json.error.code,
    ).toBe('EVIDENCE_TYPE_NOT_ALLOWED');
    const big = await upload(orgH, {
      content: {
        base64: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61).toString('base64'),
        mediaType: 'text/plain',
      },
    });
    expect([big.status, big.json.error.code]).toEqual([413, 'EVIDENCE_TOO_LARGE']);
    expect(
      (await upload(orgH, { content: { base64: 'not base64!', mediaType: 'text/plain' } })).status,
    ).toBe(400);
    const prod = await call(
      'POST',
      '/v1/evidence',
      { ...orgH, ...idem() },
      {
        content: { base64: Buffer.from(bytes).toString('base64'), mediaType: 'application/json' },
        evidenceType: 'SIGNED_SCORESHEET',
        source: { kind: 'HUMAN' },
      },
      noStorage,
    );
    expect([prod.status, prod.json.error.code]).toEqual([503, 'EVIDENCE_STORAGE_UNAVAILABLE']);
    expect((await call('POST', '/v1/evidence', idem(), {})).status).toBe(401);
  });

  it('metadata and raw content need an authorized viewer; downloads are attachment + nosniff + sandbox', async () => {
    const r = await upload(orgH);
    const meta = await call('GET', `/v1/evidence/${r.json.evidenceId}`, orgH);
    expect(meta.status).toBe(200);
    expect(meta.json.notice ?? meta.json.statement).toMatch(/not a verification/);
    const content = await call('GET', `/v1/evidence/${r.json.evidenceId}/content`, orgH);
    expect(content.status).toBe(200);
    expect(Buffer.from(content.raw)).toEqual(Buffer.from(bytes));
    expect(content.headers['content-disposition']).toMatch(/^attachment;/);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-security-policy']).toContain('sandbox');
    expect(content.headers['cache-control']).toBe('no-store');
    const denied = await call('GET', `/v1/evidence/${r.json.evidenceId}/content`, strangerH);
    const unknown = await call('GET', `/v1/evidence/${newId()}/content`, strangerH);
    expect(denied.status).toBe(404);
    expect(denied.text).toBe(unknown.text);
    expect((await call('GET', `/v1/evidence/${r.json.evidenceId}`, strangerH)).status).toBe(404);
    expect((await call('GET', `/v1/evidence/${r.json.evidenceId}/content`)).status).toBe(401);
    const restricted = await call(
      'POST',
      `/v1/evidence/${r.json.evidenceId}/restrict`,
      { ...orgH, ...idem() },
      { reasonCode: 'REVIEW' },
    );
    expect(restricted.json).toEqual({ availability: 'RESTRICTED', changed: true });
    const gone = await call('GET', `/v1/evidence/${r.json.evidenceId}/content`, orgH);
    expect([gone.status, gone.json.error.code, gone.json.error.reason]).toEqual([
      409,
      'EVIDENCE_NOT_AVAILABLE',
      'RESTRICTED',
    ]);
    expect(
      (
        await call(
          'POST',
          `/v1/internal/evidence/${r.json.evidenceId}/purge`,
          { ...orgH, ...idem() },
          { basis: 'ERASURE', reasonCode: 'X', basisRef: 'x' },
        )
      ).status,
    ).toBe(403);
  });
});

describe('BRT-06 /v1 signing: keys, attestations, retractions, public cards, bundle', () => {
  const signer = createEphemeralSigner();
  let keyId: string;
  let evidenceId: string;
  let attestationId: string;

  it('registers a public key with proof of possession (representatives only)', async () => {
    const pp = await call('POST', `/v1/persons/${personId}/principal`, orgH);
    expect(pp.status).toBe(200);
    expect(pp.json.principalId).not.toBe(personId);
    expect((await call('POST', `/v1/persons/${personId}/principal`, strangerH)).status).toBe(403);
    const deny = await call(
      'POST',
      `/v1/principals/${orgPrincipalId}/keys/prepare`,
      { ...strangerH, ...idem() },
      { algorithm: 'EdDSA', publicJwk: signer.publicJwk },
    );
    expect(deny.json.error.code).toBe('ISSUER_NOT_CONTROLLED');
    const priv = await call(
      'POST',
      `/v1/principals/${orgPrincipalId}/keys/prepare`,
      { ...orgH, ...idem() },
      { algorithm: 'EdDSA', publicJwk: { ...signer.publicJwk, d: 'A'.repeat(43) } },
    );
    expect(priv.status).toBe(400);
    const prep = await call(
      'POST',
      `/v1/principals/${orgPrincipalId}/keys/prepare`,
      { ...orgH, ...idem() },
      { algorithm: 'EdDSA', publicJwk: signer.publicJwk },
    );
    expect(prep.json.signing.signingInput).toBe(
      `${prep.json.signing.protected}.${prep.json.signing.payload}`,
    );
    const proof = {
      proofType: 'DIRECT_SIGNATURE',
      scheme: 'JWS_DETACHED',
      ...signer.signJws(prep.json.signing.kid, prep.json.statementHash),
    };
    const reg = await call(
      'POST',
      `/v1/principals/${orgPrincipalId}/keys`,
      { ...orgH, ...idem() },
      { challengeId: prep.json.challengeId, statementHash: prep.json.statementHash, proof },
    );
    expect(reg.status).toBe(201);
    keyId = reg.json.keyId;
    expect(reg.json.notice).toMatch(/not a grant of sporting authority/);
  });

  it('prepare → sign externally → submit; tamper and replay are rejected; conflicting claims coexist', async () => {
    // Distinct provenance (another sheet id): the same bytes + same provenance would return the
    // existing (now RESTRICTED) item by natural key.
    evidenceId = (
      await upload(orgH, {
        source: {
          kind: 'HUMAN',
          externalNamespace: 'fictional-scorer',
          externalId: `${S.externalId}-2`,
        },
      })
    ).json.evidenceId;
    const prep = await call(
      'POST',
      '/v1/attestations/prepare',
      { ...orgH, ...idem() },
      {
        issuerPrincipalId: orgPrincipalId,
        keyId,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
        evidenceIds: [evidenceId],
      },
    );
    expect(prep.status).toBe(200);
    const proof = {
      proofType: 'DIRECT_SIGNATURE',
      scheme: 'JWS_DETACHED',
      ...signer.signJws(keyId, prep.json.statementHash),
    };
    const tamperedPrep = await call(
      'POST',
      '/v1/attestations/prepare',
      { ...orgH, ...idem() },
      {
        issuerPrincipalId: orgPrincipalId,
        keyId,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
      },
    );
    const tampered = await call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      {
        challengeId: tamperedPrep.json.challengeId,
        statement: {
          ...tamperedPrep.json.statement,
          subject: { ...tamperedPrep.json.statement.subject, id: newId() },
        },
        proof: {
          proofType: 'DIRECT_SIGNATURE',
          scheme: 'JWS_DETACHED',
          ...signer.signJws(keyId, tamperedPrep.json.statementHash),
        },
      },
    );
    expect([tampered.status, tampered.json.error.code]).toEqual([422, 'ATTESTATION_PROOF_INVALID']);
    const ok = await call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      { challengeId: prep.json.challengeId, statement: prep.json.statement, proof },
    );
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({
      signature: 'VALID',
      authority: 'NOT_EVALUATED',
      verification: 'EVALUATED_SEPARATELY',
    });
    expect(ok.json.notice).toMatch(/not a verified result/);
    attestationId = ok.json.attestationId;
    const replay = await call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      { challengeId: prep.json.challengeId, proof },
    );
    expect([replay.status, replay.json.error.code]).toEqual([409, 'ATTESTATION_CHALLENGE_USED']);
    const big = await call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      { challengeId: prep.json.challengeId, proof: { ...proof, signature: 'A'.repeat(4096) } },
    );
    expect(big.status).toBe(400);
    const denyPrep = await call(
      'POST',
      '/v1/attestations/prepare',
      { ...orgH, ...idem() },
      {
        issuerPrincipalId: orgPrincipalId,
        keyId,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: {
          type: 'RESULT_ACCURATE',
          polarity: 'DENY',
          payload: { reasonCode: 'SCORE_INCORRECT' },
        },
      },
    );
    const deny = await call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      {
        challengeId: denyPrep.json.challengeId,
        proof: {
          proofType: 'DIRECT_SIGNATURE',
          scheme: 'JWS_DETACHED',
          ...signer.signJws(keyId, denyPrep.json.statementHash),
        },
      },
    );
    expect(deny.status).toBe(201);
    const list = await call('GET', `/v1/result-versions/${w.resultVersionId}/attestations`);
    expect(
      list.json.items.map((c: { claim: { polarity: string } }) => c.claim.polarity).sort(),
    ).toEqual(['AFFIRM', 'DENY']);
  });

  it('public card is a signed claim, never a verified result; detail is for representatives only', async () => {
    const card = await call('GET', `/v1/attestations/${attestationId}`);
    expect(card.status).toBe(200);
    expect(card.json).toMatchObject({
      kind: 'CRYPTOGRAPHICALLY_SIGNED_CLAIM',
      notice:
        'This is a cryptographically signed claim. Sporting verification is evaluated separately.',
      issuer: { type: 'ORGANIZATION', label: 'Fictional Evidence Club' },
      trust: {
        signature: 'VALID_AT_ACCEPTANCE',
        claim: 'ACTIVE',
        authority: 'NOT_EVALUATED',
        sportingVerification: 'EVALUATED_SEPARATELY',
      },
      evidence: { count: 1, available: 1 },
    });
    expect(card.text).not.toMatch(/sha256:|"nonce"|"protected"|"statementHash"|accountId|personId/);
    // BRT-07R: verification is a separate per-ResultVersion resource; no V-level is ever copied
    // onto the attestation, and no "NOT_IMPLEMENTED" remains on the public card.
    const resource = card.json.trust.verificationResource as string;
    expect(resource).toBe(`/v1/result-versions/${card.json.subject.resultVersionId}/verification`);
    expect(card.text).not.toMatch(/NOT_IMPLEMENTED|highestSatisfiedLevel|"level"|"V[0-4]"/);
    const linked = await call('GET', resource);
    expect(linked.status).toBe(200);
    expect(linked.json.resultVersionId).toBe(card.json.subject.resultVersionId);
    expect((await call('GET', `/v1/attestations/${newId()}`)).status).toBe(404);
    expect(
      (await call('GET', `/v1/attestations/${attestationId}/detail`, orgH)).json.trust.signature,
    ).toBe('VALID');
    expect((await call('GET', `/v1/attestations/${attestationId}/detail`, strangerH)).status).toBe(
      404,
    );
  });

  it('signed retraction keeps the original; the card shows RETRACTED ≠ false', async () => {
    const prep = await call(
      'POST',
      `/v1/attestations/${attestationId}/retractions/prepare`,
      { ...orgH, ...idem() },
      { keyId, reasonCode: 'WITHDRAWN' },
    );
    const r = await call(
      'POST',
      `/v1/attestations/${attestationId}/retractions`,
      { ...orgH, ...idem() },
      {
        challengeId: prep.json.challengeId,
        proof: {
          proofType: 'DIRECT_SIGNATURE',
          scheme: 'JWS_DETACHED',
          ...signer.signJws(keyId, prep.json.statementHash),
        },
      },
    );
    expect(r.status).toBe(201);
    expect(r.json.notice).toMatch(/does not mean the claim was false/);
    expect((await call('GET', `/v1/attestations/${attestationId}`)).json.trust.claim).toBe(
      'RETRACTED',
    );
    expect(
      (await call('GET', `/v1/attestations/${attestationId}/detail`, orgH)).json.statement.claim
        .polarity,
    ).toBe('AFFIRM');
  });

  it('Evidence Bundle: COMP_STAFF only, deterministic for a fixed asOf', async () => {
    const a = await call('GET', `/v1/result-versions/${w.resultVersionId}/evidence-bundle`, orgH);
    expect(a.status).toBe(200);
    const b = await call(
      'GET',
      `/v1/result-versions/${w.resultVersionId}/evidence-bundle?asOf=${encodeURIComponent(a.json.asOf)}`,
      orgH,
    );
    expect(b.json.bundleHash).toBe(a.json.bundleHash);
    expect(JSON.stringify(b.json.bundle)).toBe(JSON.stringify(a.json.bundle));
    expect(
      (await call('GET', `/v1/result-versions/${w.resultVersionId}/evidence-bundle`, strangerH))
        .status,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/result-versions/${w.resultVersionId}/evidence-bundle`)).status,
    ).toBe(401);
  });

  it('route classification is explicit and non-PUBLIC routes refuse anonymous callers', () => {
    // BRT-06 routes only (BRT-07 verification routes are classified in verification.int.test.ts).
    const brt06 = app.v1Routes.filter(
      (r) =>
        /evidence|attestation|principal|result-versions/.test(r.url) && !/verification/.test(r.url),
    );
    expect(brt06.length).toBeGreaterThanOrEqual(18);
    for (const r of brt06)
      expect([
        'PUBLIC',
        'AUTHENTICATED',
        'SELF',
        'ISSUER_REPRESENTATIVE',
        'COMP_STAFF',
        'INTERNAL',
      ]).toContain(r.classification);
    expect(
      brt06
        .filter((r) => r.classification === 'PUBLIC')
        .map((r) => r.url)
        .sort(),
    ).toEqual([
      '/v1/attestations/:attestationId',
      '/v1/result-versions/:resultVersionId/attestations',
    ]);
  });
});

describe('privacy sentinels: nothing private leaks anywhere public or into telemetry', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it('public DTOs, outbox, audit, idempotency, read models, storage paths/bytes and logs are clean', async () => {
    const publicText = [
      (await call('GET', `/v1/result-versions/${w.resultVersionId}/attestations`)).text,
      ...(
        await call('GET', `/v1/result-versions/${w.resultVersionId}/attestations`)
      ).json.items.map((c: { attestationId: string }) => c.attestationId),
    ].join('\n');
    const dump = async (q: string) => JSON.stringify((await sql.raw(q).execute(owner)).rows);
    const surfaces: Record<string, string> = {
      public: publicText,
      outbox: await dump('SELECT payload FROM platform.outbox_event'),
      audit: await dump('SELECT details FROM platform.audit_event'),
      idempotency: await dump('SELECT response FROM platform.command_idempotency'),
      readModels:
        (await dump('SELECT * FROM evidence_read.attestation_card')) +
        (await dump('SELECT * FROM evidence_read.evidence_state')),
      blobRegistry: await dump('SELECT * FROM evidence.blob'),
      logs: logLines.join('\n'),
      storagePaths: files(root).join('\n'),
    };
    const forbidden = [...Object.values(S), root, EVIDENCE_KEY, VAULT_KEY, SECRET, ...tokens];
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const v of forbidden) {
        if (surface === 'storagePaths' && v === root) continue;
        expect(text.includes(v), `${surface} contains ${v.slice(0, 24)}…`).toBe(false);
      }
    }
    for (const f of files(root))
      expect(readFileSync(f).includes(Buffer.from(S.evidenceContent))).toBe(false);
    // the public card never names the Person, Account or private identity of a signer
    expect(publicText).not.toContain(personId);
    expect(publicText).not.toContain(w.organizer.ownerAccountId);
  });
});
