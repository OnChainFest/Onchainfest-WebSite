import { DomainError, newId, type AuthorityScope } from '@br/domain';
import { sql } from 'kysely';
import { staticParticipationChecker, type ParticipationDeclaration } from '@br/authority';
import { AuthorityStore } from '../authority-store';
import { databaseUrls } from '../config';
import { createDb } from '../db';
import { verifyStreamChain } from '../ledger';
import { rebuildResultProjections, snapshotResultProjections } from '../projections';
import { ResultLedger } from '../result-ledger';
import { inTransaction, ModuleRole } from '../tx';

/**
 * BRT-03 acceptance walkthrough (steps 7–17) against the development database.
 * Run: pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm demo:foundation
 */
const db = createDb(databaseUrls().api);
// Projection rebuild is a maintenance operation: separate login (br_maintenance → br_rebuild).
const maintenanceDb = createDb(databaseUrls().maintenance, { max: 2 });
/**
 * Conflict-of-interest data source for the demo. There is no participation index yet, so the
 * demo DECLARES participation explicitly (the "stranger" plays in the contest). Without a
 * checker every conflict-sensitive action fails closed — shown in step 10f.
 */
const declared: ParticipationDeclaration[] = [];
const checker = staticParticipationChecker(declared, 'demo-declared-participation');
const store = new AuthorityStore(db, { conflictChecker: checker });
const ledger = new ResultLedger(db, { conflictChecker: checker });
const line = (step: string, detail: unknown) =>
  console.log(
    `\n▶ ${step}\n  ${typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).replaceAll('\n', '\n  ')}`,
  );
const expectFailure = async (label: string, fn: () => Promise<unknown>) => {
  try {
    const r = (await fn()) as { authorized?: boolean; reason?: string };
    if (r.authorized === false) return line(label, `DENIED as expected — ${r.reason}`);
    throw new Error(`${label}: expected a failure`);
  } catch (err) {
    if (err instanceof DomainError || (typeof err === 'object' && err !== null && 'code' in err)) {
      return line(label, `REJECTED as expected — ${(err as Error).message}`);
    }
    throw err;
  }
};

try {
  // 7. principals
  const platform = await store.registerPrincipal({
    principalType: 'PLATFORM',
    label: 'Platform (demo)',
  });
  const organizer = await store.registerPrincipal({
    principalType: 'ORGANIZATION',
    label: 'Club organizer (demo)',
  });
  const referee = await store.registerPrincipal({
    principalType: 'PERSON',
    label: 'Referee (demo)',
  });
  const stranger = await store.registerPrincipal({
    principalType: 'PERSON',
    label: 'Stranger (demo)',
  });
  line('7. principals created', {
    platform: platform.id,
    organizer: organizer.id,
    referee: referee.id,
    stranger: stranger.id,
  });

  // 8. scoped authority chain: platform anchor → organizer (competition) → referee (one contest)
  const { anchorId } = await store.recognizeTrustAnchor({
    principalId: platform.id,
    recognitionScope: { recognitionLevel: ['PLATFORM'] },
    basisRef: 'demo',
    governanceDecisionRef: 'demo (not a governance decision)',
  });
  const competition = newId();
  const contest = newId();
  declared.push({ principalId: stranger.id, scope: { contest: [contest] } }); // the stranger competes
  const competitionScope: AuthorityScope = {
    sport: ['padel'],
    recognitionLevel: ['PLATFORM'],
    competition: [competition],
  };
  const contestScope: AuthorityScope = { ...competitionScope, contest: [contest] };
  const { grant: orgGrant } = await store.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: organizer.id,
    capabilities: ['GRANT_AUTHORITY', 'SUBMIT_RESULT', 'ACCEPT_RESULT'],
    scope: competitionScope,
    delegation: {
      allowed: true,
      maxDepth: 1,
      capabilitiesDelegable: ['SUBMIT_RESULT', 'ACCEPT_RESULT'],
    },
  });
  const { grant: refGrant } = await store.issueGrant({
    actorPrincipalId: organizer.id,
    grantorPrincipalId: organizer.id,
    granteePrincipalId: referee.id,
    parentGrantId: orgGrant.id,
    capabilities: ['SUBMIT_RESULT', 'ACCEPT_RESULT'],
    scope: contestScope,
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    effectiveTo: new Date(Date.now() + 60 * 60 * 1000),
  });
  line('8. authority chain', {
    anchorId,
    organizerGrant: { id: orgGrant.id, grantHash: orgGrant.grantHash },
    refereeGrant: { id: refGrant.id, grantHash: refGrant.grantHash },
  });

  // 9. valid authorization
  const ok = await store.authorize({
    principalId: referee.id,
    capability: 'ACCEPT_RESULT',
    scope: contestScope,
  });
  line('9. referee may ACCEPT_RESULT on the contest', {
    authorized: ok.authorized,
    reason: ok.reason,
    chain: ok.grantChain.map((l) => l.grantId),
    anchorId: ok.anchorId,
    proofDigest: ok.proofDigest,
  });

  // 10. invalid / widened / expired
  await expectFailure('10a. stranger has no authority', () =>
    store.authorize({ principalId: stranger.id, capability: 'ACCEPT_RESULT', scope: contestScope }),
  );
  await expectFailure('10b. referee on another contest', () =>
    store.authorize({
      principalId: referee.id,
      capability: 'ACCEPT_RESULT',
      scope: { ...competitionScope, contest: [newId()] },
    }),
  );
  await expectFailure('10c. widened child grant', () =>
    store.issueGrant({
      actorPrincipalId: organizer.id,
      grantorPrincipalId: organizer.id,
      granteePrincipalId: stranger.id,
      parentGrantId: orgGrant.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: { sport: ['padel'], recognitionLevel: ['PLATFORM'] },
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    }),
  );
  await expectFailure('10d. backdated grant', () =>
    store.issueGrant({
      actorPrincipalId: organizer.id,
      grantorPrincipalId: organizer.id,
      granteePrincipalId: stranger.id,
      parentGrantId: orgGrant.id,
      capabilities: ['ACCEPT_RESULT'],
      scope: contestScope,
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      effectiveFrom: new Date(Date.now() - 3_600_000),
    }),
  );
  await expectFailure('10e. referee grant evaluated after its expiry', () =>
    store.authorize({
      principalId: referee.id,
      capability: 'ACCEPT_RESULT',
      scope: contestScope,
      atTime: new Date(Date.now() + 2 * 3_600_000),
    }),
  );

  // 10f. conflict of interest is fail-closed
  const bareStore = new AuthorityStore(db); // no participation data source
  await expectFailure(
    '10f. no participation data ⇒ conflict-sensitive authority fails closed',
    () =>
      bareStore.authorize({
        principalId: referee.id,
        capability: 'ACCEPT_RESULT',
        scope: contestScope,
      }),
  );
  const strangerGrant = await store.issueGrant({
    actorPrincipalId: platform.id,
    grantorPrincipalId: platform.id,
    granteePrincipalId: stranger.id,
    capabilities: ['ACCEPT_RESULT'],
    scope: contestScope,
    delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
  });
  void strangerGrant;
  await expectFailure('10g. a declared participant cannot accept results of its own contest', () =>
    store.authorize({ principalId: stranger.id, capability: 'ACCEPT_RESULT', scope: contestScope }),
  );

  // 11–12. submit a ResultVersion and show its deterministic content hash
  const result = await ledger.createResult({ scopeType: 'CONTEST', scopeTargetId: contest });
  const pairA = newId();
  const pairB = newId();
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: referee.id,
    disciplineVersionRef: 'padel.doubles@demo',
    content: {
      entries: [
        {
          participantId: pairA,
          outcome: 'WIN',
          primaryMark: { metricId: 'padel.match.sets', value: '2', unit: 'sets', precision: 0 },
        },
        {
          participantId: pairB,
          outcome: 'LOSS',
          primaryMark: { metricId: 'padel.match.sets', value: '1', unit: 'sets', precision: 0 },
        },
      ],
    },
  });
  const submitted = await ledger.submitDraft({
    draftId,
    actorPrincipalId: referee.id,
    scope: contestScope,
    idempotencyKey: `demo-submit-${newId()}`,
  });
  line('11–12. ResultVersion submitted', {
    resultVersionId: submitted.resultVersionId,
    versionNumber: submitted.versionNumber,
    contentHash: submitted.contentHash,
    status: submitted.status,
  });

  // 13. lifecycle fact
  const accepted = await ledger.transition({
    resultVersionId: submitted.resultVersionId,
    toStatus: 'PROVISIONAL',
    actorPrincipalId: referee.id,
    scope: contestScope,
    idempotencyKey: `demo-accept-${newId()}`,
  });
  line(
    '13. lifecycle facts appended to the RESULT stream',
    [...submitted.ledgerEntries, ...accepted.ledgerEntries].map((e) => ({
      seq: e.sequence,
      type: e.event_type,
      entryHash: e.entry_hash,
    })),
  );

  // 14. projection
  const state = await ledger.getResultState(result.id);
  line('14. projection updated (class B, not truth)', state);

  // 15. outbox
  const events = await inTransaction(db, ModuleRole.results, (ctx) =>
    ctx.trx
      .selectFrom('platform.outbox_event')
      .select(['id', 'event_type', 'aggregate_id'])
      .where('aggregate_id', '=', submitted.resultVersionId)
      .orderBy('id')
      .execute(),
  );
  line('15. outbox events (same transactions)', events);

  // 16. immutability
  await expectFailure('16a. api login (br_results) UPDATE of ResultVersion content', () =>
    inTransaction(db, ModuleRole.results, (ctx) =>
      sql`UPDATE results.result_version SET content = '{}' WHERE id = ${submitted.resultVersionId}`.execute(
        ctx.trx,
      ),
    ),
  );
  await expectFailure('16b. api login (br_results) DELETE of a ledger entry', () =>
    inTransaction(db, ModuleRole.results, (ctx) =>
      sql`DELETE FROM platform.ledger_entry WHERE stream_id = ${result.id}`.execute(ctx.trx),
    ),
  );
  const chain = await inTransaction(db, ModuleRole.results, (ctx) =>
    verifyStreamChain(ctx, result.id),
  );
  line('16c. hash chain verification', chain);

  // 17. rebuild projections from ledger history
  const before = await snapshotResultProjections(db);
  const stats = await rebuildResultProjections(maintenanceDb);
  const after = await snapshotResultProjections(db);
  line('17. projection rebuilt from ledger', {
    ...stats,
    identicalToLiveProjection: JSON.stringify(before) === JSON.stringify(after),
  });
} finally {
  await db.destroy();
  await maintenanceDb.destroy();
}
