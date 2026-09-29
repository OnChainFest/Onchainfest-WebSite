import { staticParticipationChecker } from '@br/authority';
import { newId, type AuthorityScope, type Uuid } from '@br/domain';
import { createEphemeralSigner, developmentEvidenceBlobStore } from '@br/evidence';
import { sql } from 'kysely';
import { AttestationStore } from '../attestation-store';
import { AuthorityStore } from '../authority-store';
import {
  CompetitionHierarchyResolver,
  createCompetitionResultLedger,
} from '../competition-hierarchy';
import { databaseUrls } from '../config';
import { createDb } from '../db';
import { EvidenceStore } from '../evidence-store';
import { IdentityStore } from '../identity-store';
import { PrincipalKeyCeremony } from '../key-ceremony-store';
import { inTransaction, ModuleRole } from '../tx';

/**
 * BRT-06 development seed. ALL DATA IS FICTIONAL. Builds on `pnpm db:seed:competition` (the
 * Fictional Padel Open): a submitted ResultVersion for its first contest, a fictional score-sheet
 * EvidenceItem attached to it, and a cryptographically signed RESULT_ACCURATE claim by the
 * fictional organizer's ORGANIZATION principal.
 *
 * Idempotent: fixed idempotency keys and "already done" detection, so re-running prints the same
 * output. The signing key is generated IN MEMORY on the first run only (its private half is never
 * written anywhere); later runs find the existing attestation and do not sign again.
 * Requires BR_EVIDENCE_DEV_DIR and BR_EVIDENCE_DEV_KEY (persistent encrypted evidence store).
 * Run: pnpm db:seed:competition && pnpm db:seed:evidence
 */
if (process.env.NODE_ENV === 'production') throw new Error('development seed refuses production');
const blobStore = developmentEvidenceBlobStore();
if (blobStore === undefined) {
  throw new Error(
    'the evidence seed needs a persistent development store: set BR_EVIDENCE_DEV_DIR (absolute path) and BR_EVIDENCE_DEV_KEY (e.g. `export BR_EVIDENCE_DEV_KEY=$(openssl rand -hex 32)`)',
  );
}
const AUDIENCE = process.env.BR_SIGNATURE_AUDIENCE ?? 'bragging-rights:development';
const db = createDb(databaseUrls().api, { max: 4 });
const identity = new IdentityStore(db);
const noParticipation = staticParticipationChecker([], 'seed-declared-no-participation');
const authority = new AuthorityStore(db, { conflictChecker: noParticipation });
const ledger = createCompetitionResultLedger(db, { conflictChecker: noParticipation });
const resolver = new CompetitionHierarchyResolver(db);
const evidence = new EvidenceStore(db, { blobStore });
const attestations = new AttestationStore(db, { audience: AUDIENCE });
const ceremony = new PrincipalKeyCeremony(db, { audience: AUDIENCE });

try {
  const { accountId: organizer } = await identity.signIn({
    provider: 'test',
    providerSubject: 'seed:comp-organizer',
    method: 'TEST',
  });
  const found = await inTransaction(db, ModuleRole.competition, async (ctx) => {
    const { rows } = await sql<{
      competition_id: string;
      organization_id: string;
      contest_id: string;
      participant_id: string;
    }>`
      SELECT c.id AS competition_id, c.organizer_organization_id AS organization_id, ct.id AS contest_id, t.participant_id
      FROM competition.competition_slug s
      JOIN competition.competition c ON c.id = s.competition_id
      JOIN competition.event e ON e.competition_id = c.id
      JOIN competition.contest ct ON ct.event_id = e.id
      JOIN competition.contestant t ON t.contest_id = ct.id
      WHERE s.slug = 'fictional-padel-open' AND t.participant_id IS NOT NULL
      ORDER BY ct.sequence, t.slot`.execute(ctx.trx);
    const first = rows[0];
    if (first === undefined) return undefined;
    return {
      competitionId: first.competition_id,
      organizationId: first.organization_id,
      contestId: first.contest_id,
      participants: rows
        .filter((r) => r.contest_id === first.contest_id)
        .map((r) => r.participant_id),
    };
  });
  if (found === undefined || found.participants.length < 2)
    throw new Error('run `pnpm db:seed:competition` first (Fictional Padel Open not found)');

  const result = await ledger.createResult({
    scopeType: 'CONTEST',
    scopeTargetId: found.contestId as Uuid,
  });
  const existingVersion = await inTransaction(
    db,
    ModuleRole.results,
    async (ctx) =>
      (
        await sql<{ id: string; content_hash: string }>`
      SELECT id, content_hash FROM results.result_version WHERE result_id = ${result.id} ORDER BY version_number LIMIT 1`.execute(
          ctx.trx,
        )
      ).rows[0],
  );
  let resultVersion =
    existingVersion === undefined
      ? undefined
      : { id: existingVersion.id, contentHash: existingVersion.content_hash };
  if (resultVersion === undefined) {
    // A fictional referee under a fictional PLATFORM-level anchor submits the version (SUBMITTED only).
    const platform = await authority.registerPrincipal({
      principalType: 'PLATFORM',
      label: 'platform (evidence seed)',
    });
    await authority.recognizeTrustAnchor({
      principalId: platform.id,
      recognitionScope: { recognitionLevel: ['PLATFORM'] },
      basisRef: 'development seed',
      governanceDecisionRef: 'seed:evidence',
    });
    const referee = await authority.registerPrincipal({
      principalType: 'PERSON',
      label: 'fictional referee (evidence seed)',
    });
    await authority.issueGrant({
      actorPrincipalId: platform.id,
      grantorPrincipalId: platform.id,
      granteePrincipalId: referee.id,
      capabilities: ['SUBMIT_RESULT'],
      scope: { recognitionLevel: ['PLATFORM'], competition: [found.competitionId as Uuid] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    });
    const [winner, loser] = found.participants as [string, string];
    const { draftId } = await ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: referee.id,
      disciplineVersionRef: 'padel.doubles@1',
      content: {
        entries: [
          {
            participantId: winner,
            outcome: 'WIN',
            primaryMark: { metricId: 'padel.match.sets', value: '2', unit: 'sets', precision: 0 },
          },
          {
            participantId: loser,
            outcome: 'LOSS',
            primaryMark: { metricId: 'padel.match.sets', value: '1', unit: 'sets', precision: 0 },
          },
        ],
      },
    });
    const scope = {
      ...(await resolver.scopeOf('CONTEST', found.contestId)),
      recognitionLevel: ['PLATFORM'],
    } as AuthorityScope;
    const v = await ledger.submitDraft({
      draftId,
      actorPrincipalId: referee.id,
      scope,
      idempotencyKey: 'seed:evidence:result-version',
    });
    resultVersion = { id: v.resultVersionId, contentHash: v.contentHash };
  }

  const orgPrincipalId = await inTransaction(
    db,
    ModuleRole.evidence,
    async (ctx) =>
      (
        await sql<{ principal_id: string }>`
      SELECT principal_id FROM organizations.organization_principal WHERE organization_id = ${found.organizationId}`.execute(
          ctx.trx,
        )
      ).rows[0]?.principal_id,
  );
  if (orgPrincipalId === undefined) throw new Error('organizer principal not found');

  const sheet = await evidence.ingest({
    actorAccountId: organizer,
    idempotencyKey: 'seed:evidence:score-sheet',
    bytes: new TextEncoder().encode(
      JSON.stringify({
        fictional: true,
        competition: 'Fictional Padel Open',
        contest: 1,
        sets: ['6-4', '3-6', '6-2'],
        signedBy: 'fictional referee',
      }),
    ),
    mediaType: 'application/json',
    evidenceType: 'SIGNED_SCORESHEET',
    source: { kind: 'ORGANIZATION', principalId: orgPrincipalId as Uuid },
    attachTo: { targetType: 'RESULT_VERSION', targetId: resultVersion.id, role: 'PRIMARY' },
  });

  const existing = await inTransaction(
    db,
    ModuleRole.evidence,
    async (ctx) =>
      (
        await sql<{ id: string; statement_hash: string; key_id: string }>`
      SELECT id, statement_hash, key_id FROM attestation.attestation
      WHERE subject_id = ${resultVersion.id} AND issuer_principal_id = ${orgPrincipalId} ORDER BY recorded_at, id LIMIT 1`.execute(
          ctx.trx,
        )
      ).rows[0],
  );
  let attestation =
    existing === undefined
      ? undefined
      : {
          attestationId: existing.id,
          statementHash: existing.statement_hash,
          keyId: existing.key_id,
        };
  if (attestation === undefined) {
    const signer = createEphemeralSigner('EdDSA'); // in memory only; never persisted
    const prep = await ceremony.prepareKeyRegistration({
      actorAccountId: organizer,
      idempotencyKey: `seed-key-${newId()}`,
      principalId: orgPrincipalId,
      algorithm: 'EdDSA',
      publicJwk: signer.publicJwk,
    });
    const { keyId } = await ceremony.submitKeyRegistration({
      actorAccountId: organizer,
      idempotencyKey: `seed-key-${newId()}`,
      principalId: orgPrincipalId,
      challengeId: prep.challengeId,
      proof: {
        proofType: 'DIRECT_SIGNATURE',
        scheme: 'JWS_DETACHED',
        ...signer.signJws(prep.signing.kid, prep.statementHash),
      },
    });
    const p = await attestations.prepare({
      actorAccountId: organizer,
      idempotencyKey: `seed-att-${newId()}`,
      issuerPrincipalId: orgPrincipalId,
      keyId,
      subject: { type: 'RESULT_VERSION', id: resultVersion.id },
      claim: { type: 'RESULT_ACCURATE', polarity: 'AFFIRM' },
      authorityContext: { actingRole: 'ORGANIZER' },
      evidenceIds: [sheet.evidenceId],
    });
    const r = await attestations.submit({
      actorAccountId: organizer,
      idempotencyKey: `seed-att-${newId()}`,
      challengeId: p.challengeId,
      proof: {
        proofType: 'DIRECT_SIGNATURE',
        scheme: 'JWS_DETACHED',
        ...signer.signJws(keyId, p.statementHash),
      },
    });
    attestation = { attestationId: r.attestationId, statementHash: r.statementHash, keyId };
  }

  console.log(
    JSON.stringify(
      {
        fictionalDataOnly: true,
        competition: 'fictional-padel-open',
        contestId: found.contestId,
        resultVersion: {
          id: resultVersion.id,
          contentHash: resultVersion.contentHash,
          status: 'SUBMITTED (never accepted or verified by this seed)',
        },
        evidence: {
          evidenceId: sheet.evidenceId,
          descriptorHash: sheet.descriptorHash,
          contentHash: sheet.contentHash,
        },
        attestation: {
          ...attestation,
          claim: 'RESULT_ACCURATE/AFFIRM',
          meaning: 'cryptographically signed claim; authority not evaluated; not a verification',
        },
        pages: [`/attestations/${attestation.attestationId}`],
      },
      null,
      2,
    ),
  );
} finally {
  await db.destroy();
}
