import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staticParticipationChecker } from '@br/authority';
import { newId, type Uuid } from '@br/domain';
import {
  createDevelopmentEvidenceCipher,
  createEphemeralSigner,
  FilesystemEvidenceBlobStore,
  type EphemeralSigner,
} from '@br/evidence';
import {
  AttestationStore,
  AuthorityStore,
  authorizeInHierarchy,
  CatalogStore,
  CompetitionHierarchyResolver,
  CompetitionStore,
  createCompetitionResultLedger,
  createDb,
  databaseUrls,
  IdentityStore,
  inTransaction,
  ModuleRole,
  operatorDatabaseUrl,
  OrganizationStore,
  rebuildEvidenceReadModels,
  snapshotEvidenceReadModels,
  StructureStore,
} from '@br/persistence';
import { newContestResult, seedTestCatalog, uniqueSlug } from '@br/testkit';
import { sql } from 'kysely';
import { createDevTokenAuth, mintDevToken } from '../auth';
import { buildServer } from '../server';

/**
 * BRT-06 acceptance walkthrough (40 steps) through the real /v1 surface (in-process inject) plus
 * database-level proofs. ALL DATA IS FICTIONAL. Development only. No built-in secrets: the dev-auth
 * secret and the evidence key are random per run, the evidence store is a fresh temp directory, and
 * every signing key is generated in memory (its private half is never written anywhere).
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:evidence
 */
if (process.env.NODE_ENV === 'production') throw new Error('the demo refuses production');
const devAuthSecret = randomBytes(32).toString('hex');
const evidenceKey = randomBytes(32).toString('hex');
const root = mkdtempSync(join(tmpdir(), 'br-evidence-demo-'));
const AUD = 'bragging-rights:development';
const urls = databaseUrls();
const db = createDb(urls.api);
const maintenanceDb = createDb(urls.maintenance, { max: 2 });
const operatorUrl = operatorDatabaseUrl();
if (operatorUrl === undefined) throw new Error('the demo needs an operator database URL');
const operatorDb = createDb(operatorUrl, { max: 2 });
const logLines: string[] = [];
const app = buildServer({
  db,
  auth: (identity) => createDevTokenAuth(identity, { secret: devAuthSecret }),
  evidenceBlobStore: new FilesystemEvidenceBlobStore({
    root,
    cipher: createDevelopmentEvidenceCipher({ keyMaterial: evidenceKey }),
  }),
  signatureAudience: AUD,
  logStream: { write: (l: string) => void logLines.push(l) },
});
const noParticipation = staticParticipationChecker([], 'demo-declared-no-participation');

const run = newId().replace(/-/g, '').slice(-8);
const SENTINEL = `DEMO-EVIDENCE-PLAINTEXT-${run}`;
let step = 0;
const show = (title: string, detail: unknown) =>
  console.log(
    `\n▶ ${String(++step).padStart(2, '0')}. ${title}\n   ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n   ')}`,
  );
const tokens: string[] = [];
const bearer = (s: string) => {
  const t = mintDevToken(`demo6-${run}-${s}`, { secret: devAuthSecret });
  tokens.push(t);
  return { authorization: `Bearer ${t}` };
};
const idem = () => ({ 'idempotency-key': `demo6-${newId()}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form navigation of JSON responses
type Json = Record<string, any>;
async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  headers: Record<string, string> = {},
  payload?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  const json = res.headers['content-type']?.toString().includes('json')
    ? (res.json() as Json)
    : null;
  return {
    status: res.statusCode,
    text: res.body,
    raw: res.rawPayload,
    headers: res.headers,
    body: json as Json,
  };
}
async function ok(p: ReturnType<typeof call>, status = 200): Promise<Json> {
  const r = await p;
  if (r.status !== status) throw new Error(`expected HTTP ${status}, got ${r.status}: ${r.text}`);
  return r.body;
}
async function code(p: ReturnType<typeof call>): Promise<string> {
  const r = await p;
  return `${r.status} ${r.body?.error?.code ?? ''}`.trim();
}
const failures: string[] = [];
const check = (what: string, condition: boolean) => {
  if (!condition) failures.push(what);
  return condition;
};
const proofOf = (signer: EphemeralSigner, kid: string, statementHash: string) => ({
  proofType: 'DIRECT_SIGNATURE',
  scheme: 'JWS_DETACHED',
  ...signer.signJws(kid, statementHash),
});
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

try {
  // 1
  show('Service health and readiness', {
    health: (await call('GET', '/health')).body,
    ready: (await call('GET', '/ready')).body,
  });

  // 2–3: fictional competition → event → contest → Result → exact ResultVersion (BRT-05 ledger)
  const orgH = bearer('organizer');
  const me = await ok(call('GET', '/v1/me', orgH));
  const person = await ok(
    call('POST', '/v1/persons', { ...orgH, ...idem() }, { relation: 'SELF' }),
    201,
  );
  const org = await ok(
    call(
      'POST',
      '/v1/organizations',
      { ...orgH, ...idem() },
      {
        orgType: 'CLUB',
        slug: `demo-evidence-club-${run}`,
        profile: { displayName: 'Fictional Evidence Club' },
      },
    ),
    201,
  );
  const identity = new IdentityStore(db);
  const w = await newContestResult({
    db,
    identity,
    orgs: new OrganizationStore(db),
    comps: new CompetitionStore(db),
    structure: new StructureStore(db),
    authority: new AuthorityStore(db, { conflictChecker: noParticipation }),
    ledger: createCompetitionResultLedger(db, { conflictChecker: noParticipation }),
    resolver: new CompetitionHierarchyResolver(db),
    catalog: await seedTestCatalog(identity, new CatalogStore(operatorDb)),
    organizer: {
      ownerAccountId: me.accountId,
      ownerPersonId: person.personId,
      organizationId: org.organizationId,
      slug: org.slug,
    },
  });
  show('Fictional competition → event → contest (built by the BRT-05 engines)', {
    competitionId: w.competitionId,
    eventId: w.eventId,
    contestId: w.contestId,
  });
  const statusOf = () =>
    inTransaction(
      db,
      ModuleRole.results,
      async (ctx) =>
        (
          await sql<{
            current_status: string;
          }>`SELECT current_status FROM results.result_version_state WHERE result_version_id = ${w.resultVersionId}`.execute(
            ctx.trx,
          )
        ).rows[0]?.current_status,
    );
  const statusBefore = await statusOf();
  show(
    'Result + exact ResultVersion via createCompetitionResultLedger (never a bare ResultLedger)',
    {
      resultId: w.resultId,
      resultVersionId: w.resultVersionId,
      contentHash: w.contentHash,
      status: statusBefore,
    },
  );

  // 4–5
  const sheet = new TextEncoder().encode(
    JSON.stringify({ fictional: true, sets: ['6-4', '6-3'], note: SENTINEL }),
  );
  const upload = (headers: Record<string, string>, source: Json, extra: Json = {}) =>
    call(
      'POST',
      '/v1/evidence',
      { ...headers, ...idem() },
      {
        content: { base64: Buffer.from(sheet).toString('base64'), mediaType: 'application/json' },
        evidenceType: 'SIGNED_SCORESHEET',
        source,
        ...extra,
      },
    );
  const human = await ok(upload(orgH, { kind: 'HUMAN' }), 201);
  show('Ingest a PRIVATE fictional score sheet (bytes never leave the encrypted store)', {
    evidenceId: human.evidenceId,
    privacyDefault: 'PLATFORM_PRIVATE',
    notice: human.notice,
  });
  const localHash = `sha256:${createHash('sha256').update(sheet).digest('hex')}`;
  show('Server-computed content hash = sha256sum of the exact bytes', {
    server: human.contentHash,
    local: localHash,
    equal: check('content hash', human.contentHash === localHash),
  });

  // 6–7
  const orgItem = await ok(
    upload(orgH, { kind: 'ORGANIZATION', principalId: org.principalId }),
    201,
  );
  show('Identical bytes, distinct provenance (ORGANIZATION principal as source)', {
    evidenceId: orgItem.evidenceId,
    sameContentHash: orgItem.contentHash === human.contentHash,
  });
  const counts = await inTransaction(db, ModuleRole.evidence, async (ctx) => ({
    blobs: (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM evidence.blob WHERE content_hash = ${human.contentHash}`.execute(
        ctx.trx,
      )
    ).rows[0]?.n,
    items: (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM evidence.item WHERE content_hash = ${human.contentHash}`.execute(
        ctx.trx,
      )
    ).rows[0]?.n,
  }));
  show('One blob, two EvidenceItems (provenance is never deduplicated)', {
    ...counts,
    ok: check('one blob two items', counts.blobs === 1 && counts.items === 2),
  });

  // 8
  const att = await ok(
    call(
      'POST',
      `/v1/evidence/${orgItem.evidenceId}/attachments`,
      { ...orgH, ...idem() },
      { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'PRIMARY' },
    ),
    201,
  );
  show('Attach the evidence to the EXACT ResultVersion', {
    attachmentId: att.attachmentId,
    meaning: att.meaning,
  });

  // 9–10
  const personPrincipal = await ok(call('POST', `/v1/persons/${person.personId}/principal`, orgH));
  show(
    'Signing principals: ORGANIZATION principal (BRT-04) and an explicit PERSON principal (≠ Person id)',
    {
      organizationPrincipalId: org.principalId,
      personPrincipalId: personPrincipal.principalId,
      personIdDiffers: personPrincipal.principalId !== person.personId,
    },
  );
  const orgSigner = createEphemeralSigner('EdDSA');
  const kp = await ok(
    call(
      'POST',
      `/v1/principals/${org.principalId}/keys/prepare`,
      { ...orgH, ...idem() },
      { algorithm: 'EdDSA', publicJwk: orgSigner.publicJwk },
    ),
  );
  const key = await ok(
    call(
      'POST',
      `/v1/principals/${org.principalId}/keys`,
      { ...orgH, ...idem() },
      {
        challengeId: kp.challengeId,
        statementHash: kp.statementHash,
        proof: proofOf(orgSigner, kp.signing.kid, kp.statementHash),
      },
    ),
    201,
  );
  show('Register a PUBLIC key with proof of possession (private key stays with the signer)', {
    keyId: key.keyId,
    publicJwkMembers: Object.keys(orgSigner.publicJwk).sort(),
    notice: key.notice,
  });

  // 11–15
  const prepareBody = (claim: Json, extra: Json = {}) => ({
    issuerPrincipalId: org.principalId,
    keyId: key.keyId,
    subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
    claim,
    evidenceIds: [orgItem.evidenceId],
    ...extra,
  });
  const prep = await ok(
    call(
      'POST',
      '/v1/attestations/prepare',
      { ...orgH, ...idem() },
      prepareBody(
        { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
        { authorityContext: { actingRole: 'ORGANIZER' } },
      ),
    ),
  );
  show('Prepare: the server canonicalizes the EXACT statement and issues a single-use challenge', {
    challengeId: prep.challengeId,
    expiresAt: prep.expiresAt,
    subject: prep.statement.subject,
    audience: prep.statement.audience,
    nonce: prep.statement.nonce,
  });
  show('Canonical statement hash (BR-JSON + JCS + SHA-256, domain "attestation-statement")', {
    statementHash: prep.statementHash,
    canonicalStatement: `${String(prep.canonicalStatement).slice(0, 120)}…`,
  });
  const proof = proofOf(orgSigner, key.keyId, prep.statementHash);
  show('Sign externally (in memory): JWS_DETACHED EdDSA over the documented preimage', {
    signingInput: `${String(prep.signing.signingInput).slice(0, 72)}…`,
    signatureBytes: Buffer.from(proof.signature, 'base64url').length,
  });
  const accepted = await ok(
    call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      { challengeId: prep.challengeId, statement: prep.statement, proof },
    ),
    201,
  );
  show('Submit the valid attestation', {
    attestationId: accepted.attestationId,
    notice: accepted.notice,
  });
  const detail = await ok(call('GET', `/v1/attestations/${accepted.attestationId}/detail`, orgH));
  show('Signature accepted and re-verified from stored material (cryptography only)', detail.trust);
  check('signature valid', detail.trust.signature === 'VALID');

  // 16–19
  const p2 = await ok(
    call(
      'POST',
      '/v1/attestations/prepare',
      { ...orgH, ...idem() },
      prepareBody({ type: 'RESULT_ACCURATE', polarity: 'AFFIRM' }),
    ),
  );
  const tampered = await code(
    call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      {
        challengeId: p2.challengeId,
        statement: { ...p2.statement, claim: { type: 'RESULT_ACCURATE', polarity: 'DENY' } },
        proof: proofOf(orgSigner, key.keyId, p2.statementHash),
      },
    ),
  );
  show('Tampered statement is rejected (and the challenge is burnt)', tampered);
  const replay = await code(
    call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      { challengeId: prep.challengeId, proof },
    ),
  );
  show('Challenge replay is rejected', replay);
  const p3 = await ok(
    call(
      'POST',
      '/v1/attestations/prepare',
      { ...orgH, ...idem() },
      prepareBody({ type: 'RESULT_ACCURATE', polarity: 'AFFIRM' }),
    ),
  );
  const wrongKey = await code(
    call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      {
        challengeId: p3.challengeId,
        proof: proofOf(createEphemeralSigner(), key.keyId, p3.statementHash),
      },
    ),
  );
  show('A signature from another key is rejected', wrongKey);
  const staging = new AttestationStore(db, { audience: 'bragging-rights:staging' });
  const p4 = await staging.prepare({
    actorAccountId: me.accountId,
    idempotencyKey: `demo6-${newId()}`,
    issuerPrincipalId: org.principalId,
    keyId: key.keyId,
    subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
    claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
  });
  const wrongAudience = await code(
    call(
      'POST',
      '/v1/attestations',
      { ...orgH, ...idem() },
      { challengeId: p4.challengeId, proof: proofOf(orgSigner, key.keyId, p4.statementHash) },
    ),
  );
  show('A statement signed for another audience (staging) is rejected here', wrongAudience);
  check(
    'tamper/replay/key/audience rejected',
    [tampered, replay, wrongKey, wrongAudience].every((c) =>
      /^(4\d\d) (ATTESTATION_PROOF_INVALID|ATTESTATION_CHALLENGE_USED)$/.test(c),
    ),
  );

  // 20–21
  const card = await ok(call('GET', `/v1/attestations/${accepted.attestationId}`));
  show('Public attestation metadata (no statement bytes, hashes, keys or private identity)', card);
  show('What it means', { kind: card.kind, notice: card.notice, trust: card.trust });
  check('no verified wording', !/verified result|"VERIFIED"/i.test(JSON.stringify(card)));

  // 22–23
  const refH = bearer('referee-assoc');
  await ok(call('POST', '/v1/persons', { ...refH, ...idem() }, { relation: 'SELF' }), 201);
  const org2 = await ok(
    call(
      'POST',
      '/v1/organizations',
      { ...refH, ...idem() },
      {
        orgType: 'FEDERATION',
        slug: uniqueSlug('demo-fed'),
        profile: { displayName: 'Fictional Referee Federation' },
      },
    ),
    201,
  );
  const s2 = createEphemeralSigner('ES256');
  const kp2 = await ok(
    call(
      'POST',
      `/v1/principals/${org2.principalId}/keys/prepare`,
      { ...refH, ...idem() },
      { algorithm: 'ES256', publicJwk: s2.publicJwk },
    ),
  );
  const key2 = await ok(
    call(
      'POST',
      `/v1/principals/${org2.principalId}/keys`,
      { ...refH, ...idem() },
      { challengeId: kp2.challengeId, proof: proofOf(s2, kp2.signing.kid, kp2.statementHash) },
    ),
    201,
  );
  const dp = await ok(
    call(
      'POST',
      '/v1/attestations/prepare',
      { ...refH, ...idem() },
      {
        issuerPrincipalId: org2.principalId,
        keyId: key2.keyId,
        subject: { type: 'RESULT_VERSION', id: w.resultVersionId },
        claim: {
          type: 'RESULT_ACCURATE',
          polarity: 'DENY',
          payload: { reasonCode: 'SCORE_INCORRECT' },
        },
        authorityContext: { actingRole: 'OFFICIAL' },
      },
    ),
  );
  const deny = await ok(
    call(
      'POST',
      '/v1/attestations',
      { ...refH, ...idem() },
      { challengeId: dp.challengeId, proof: proofOf(s2, key2.keyId, dp.statementHash) },
    ),
    201,
  );
  show('A conflicting signed claim (DENY, ES256) from a fictional FEDERATION-type organization', {
    attestationId: deny.attestationId,
  });
  const list = await ok(call('GET', `/v1/result-versions/${w.resultVersionId}/attestations`));
  show(
    'Both claims coexist — BRT-06 chooses no winner',
    list.items.map((c: Json) => `${c.issuer.label}: ${c.claim.type}/${c.claim.polarity}`),
  );
  check('conflict coexists', list.items.length === 2);

  // 24–25
  const rp = await ok(
    call(
      'POST',
      `/v1/attestations/${deny.attestationId}/retractions/prepare`,
      { ...refH, ...idem() },
      { keyId: key2.keyId, reasonCode: 'WITHDRAWN' },
    ),
  );
  const ret = await ok(
    call(
      'POST',
      `/v1/attestations/${deny.attestationId}/retractions`,
      { ...refH, ...idem() },
      { challengeId: rp.challengeId, proof: proofOf(s2, key2.keyId, rp.statementHash) },
    ),
    201,
  );
  show('Signed retraction of the DENY claim', {
    retractionId: ret.retractionId,
    notice: ret.notice,
  });
  const retractedDetail = await ok(
    call('GET', `/v1/attestations/${deny.attestationId}/detail`, refH),
  );
  show('The original attestation remains, unchanged; only its claim status reads RETRACTED', {
    statementHash: retractedDetail.statementHash === deny.statementHash,
    polarity: retractedDetail.statement.claim.polarity,
    claim: retractedDetail.trust.claim,
  });

  // 26–28
  await ok(
    call(
      'POST',
      `/v1/evidence/${human.evidenceId}/restrict`,
      { ...orgH, ...idem() },
      { reasonCode: 'RIGHTS_REVIEW' },
    ),
  );
  const blocked = await code(call('GET', `/v1/evidence/${human.evidenceId}/content`, orgH));
  show('Mark one EvidenceItem unavailable (RESTRICTED): bytes are not inspectable', blocked);
  const meta = await ok(call('GET', `/v1/evidence/${human.evidenceId}`, orgH));
  show('…its descriptor and content hash remain', {
    descriptorHash: meta.descriptorHash,
    contentHash: meta.contentHash,
    availability: meta.availability,
  });
  const redacted = await ok(
    call(
      'POST',
      '/v1/evidence',
      { ...orgH, ...idem() },
      {
        content: {
          base64: Buffer.from(
            '{"fictional":true,"sets":["6-4","6-3"],"note":"[redacted]"}',
          ).toString('base64'),
          mediaType: 'application/json',
        },
        evidenceType: 'SIGNED_SCORESHEET',
        source: { kind: 'HUMAN' },
        lineage: [{ relation: 'REDACTED_FROM', evidenceId: orgItem.evidenceId }],
        attachTo: { targetType: 'RESULT_VERSION', targetId: w.resultVersionId, role: 'SUPPORTING' },
      },
    ),
    201,
  );
  const parent = await ok(call('GET', `/v1/evidence/${orgItem.evidenceId}`, orgH));
  show('A redacted copy is a NEW item with immutable lineage; the original is untouched', {
    redacted: redacted.evidenceId,
    parentDerivatives: parent.derivatives,
    parentDescriptorUnchanged: parent.descriptorHash === orgItem.descriptorHash,
  });

  // 29–31
  const bundle = await ok(
    call('GET', `/v1/result-versions/${w.resultVersionId}/evidence-bundle`, orgH),
  );
  show('Build the deterministic Evidence Bundle (BRT-07 input; no verdict inside)', {
    evidence: bundle.bundle.evidence.map(
      (e: Json) => `${e.evidenceType} ${e.inclusion.join('+')} ${e.availability.status}`,
    ),
    attestations: bundle.bundle.attestations.length,
    lineage: bundle.bundle.lineage.length,
  });
  show('Bundle hash (identifies these exact inputs — not a truth or verification proof)', {
    asOf: bundle.asOf,
    bundleHash: bundle.bundleHash,
  });
  const before = await snapshotEvidenceReadModels(db);
  const rebuilt = await rebuildEvidenceReadModels(maintenanceDb);
  const after = await snapshotEvidenceReadModels(db);
  const again = await ok(
    call(
      'GET',
      `/v1/result-versions/${w.resultVersionId}/evidence-bundle?asOf=${encodeURIComponent(bundle.asOf)}`,
      orgH,
    ),
  );
  show('Rebuild read models (maintenance login, metadata only) and reproduce the bundle', {
    rebuilt,
    projectionsIdentical: JSON.stringify(before) === JSON.stringify(after),
    sameBundleHash: again.bundleHash === bundle.bundleHash,
  });
  check(
    'rebuild + reproduce',
    JSON.stringify(before) === JSON.stringify(after) && again.bundleHash === bundle.bundleHash,
  );

  // 32–34
  const statusAfter = await statusOf();
  show('Result lifecycle did not move', { before: statusBefore, after: statusAfter });
  check('status unchanged', statusBefore === statusAfter);
  const verificationTables = await inTransaction(
    db,
    ModuleRole.evidence,
    async (ctx) =>
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name ~ '(verification|achievement|record_mark|prize)'`.execute(
          ctx.trx,
        )
      ).rows[0]?.n,
  );
  show('No Verification was created (none exists in BRT-06)', { verificationTables });
  const forbiddenEvents = await inTransaction(
    db,
    ModuleRole.evidence,
    async (ctx) =>
      (
        await sql<{
          n: number;
          // BRT-08/09: rule / category administration and record-evaluation log events are not
          // consequences; no Achievement, RecordMark or Prize consequence is derived here.
        }>`SELECT count(*)::int AS n FROM platform.outbox_event WHERE event_type ~ '(Verified|AchievementDerived|AchievementCurrentStateChanged|RecordMark|CurrentRecordChanged|Prize)'`.execute(
          ctx.trx,
        )
      ).rows[0]?.n,
  );
  show('No Achievement / Record / Prize event was emitted', { forbiddenEvents });
  check('no verification/achievement', verificationTables === 0 && forbiddenEvents === 0);

  // 35–36
  const anon = await code(call('GET', `/v1/evidence/${orgItem.evidenceId}/content`));
  show('Private evidence bytes are not public', {
    anonymousContentRequest: anon,
    publicCardContainsBytes: JSON.stringify(card).includes(SENTINEL),
  });
  const stranger = await code(
    call('GET', `/v1/evidence/${orgItem.evidenceId}/content`, bearer('stranger')),
  );
  show(
    'An unrelated account cannot fetch the raw evidence (indistinguishable from not found)',
    stranger,
  );
  check('no public bytes', anon.startsWith('401') && stranger.startsWith('404'));

  // 37
  const authorityFacts = await inTransaction(db, ModuleRole.authority, async (ctx) => ({
    grantsToOrgPrincipals: (
      await sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM authority.authority_grant WHERE grantee_principal_id IN (${org.principalId}, ${org2.principalId})`.execute(
        ctx.trx,
      )
    ).rows[0]?.n,
    attestResult: (
      await authorizeInHierarchy(
        ctx,
        {
          principalId: org2.principalId as Uuid,
          capability: 'ATTEST_RESULT',
          target: { level: 'CONTEST', id: w.contestId },
          recognitionLevel: 'PLATFORM',
          atTime: ctx.txTime,
          asOf: ctx.txTime,
        },
        noParticipation,
      )
    ).authorized,
  }));
  show(
    'Organization representation + a valid signature (even a FEDERATION type) manufacture no sporting authority',
    authorityFacts,
  );
  check('no authority', authorityFacts.grantsToOrgPrincipals === 0 && !authorityFacts.attestResult);

  // 38
  const rowBefore = await inTransaction(db, ModuleRole.evidence, async (ctx) =>
    JSON.stringify(
      (
        await sql`SELECT * FROM attestation.attestation WHERE id = ${accepted.attestationId}`.execute(
          ctx.trx,
        )
      ).rows,
    ),
  );
  await ok(
    call(
      'POST',
      `/v1/principals/${org.principalId}/keys/${key.keyId}/declare-compromised`,
      { ...orgH, ...idem() },
      { compromisedSince: new Date(Date.now() - 3_600_000).toISOString() },
    ),
  );
  const rowAfter = await inTransaction(db, ModuleRole.evidence, async (ctx) =>
    JSON.stringify(
      (
        await sql`SELECT * FROM attestation.attestation WHERE id = ${accepted.attestationId}`.execute(
          ctx.trx,
        )
      ).rows,
    ),
  );
  const now = await ok(
    call('GET', `/v1/result-versions/${w.resultVersionId}/evidence-bundle`, orgH),
  );
  const then = await ok(
    call(
      'GET',
      `/v1/result-versions/${w.resultVersionId}/evidence-bundle?asOf=${encodeURIComponent(bundle.asOf)}`,
      orgH,
    ),
  );
  show(
    'Declare the signing key compromised (retroactive): history remains, the bundle exposes the fact for BRT-07',
    {
      attestationRowUnchanged: rowBefore === rowAfter,
      asKnownThenHashUnchanged: then.bundleHash === bundle.bundleHash,
      asKnownNowHashChanged: now.bundleHash !== bundle.bundleHash,
      keyStatusChanges: now.bundle.keys
        .find((k: Json) => k.keyId === key.keyId)
        ?.statusChanges?.map((c: Json) => c.kind),
    },
  );
  check(
    'compromise keeps history',
    rowBefore === rowAfter &&
      then.bundleHash === bundle.bundleHash &&
      now.bundleHash !== bundle.bundleHash,
  );

  // 39
  const telemetry = await inTransaction(db, ModuleRole.evidence, async (ctx) =>
    JSON.stringify((await sql`SELECT payload FROM platform.outbox_event`.execute(ctx.trx)).rows),
  );
  const onDisk = files(root)
    .map((f) => readFileSync(f))
    .some((b) => b.includes(Buffer.from(SENTINEL)));
  const leaks = [SENTINEL, evidenceKey, devAuthSecret, root, ...tokens].filter(
    (v) => telemetry.includes(v) || logLines.join('\n').includes(v),
  );
  show('Outbox, logs and the encrypted store hold no evidence bytes, keys, paths or tokens', {
    leaks: leaks.length,
    plaintextOnDisk: onDisk,
  });
  check('no leaks', leaks.length === 0 && !onDisk);

  // 40
  show('Summary', failures.length === 0 ? 'all checks green' : { failures });
  if (step !== 40) throw new Error(`demo expected 40 steps, ran ${step}`);
  if (failures.length > 0) throw new Error(`demo invariant violated: ${failures.join(', ')}`);
  console.log('\n✔ BRT-06 demo completed: 40/40 steps.');
} finally {
  await app.close();
  await Promise.all([db.destroy(), maintenanceDb.destroy(), operatorDb.destroy()]);
}
