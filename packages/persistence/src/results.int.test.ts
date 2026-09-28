import { newId } from '@br/domain';
import { staticParticipationChecker } from '@br/authority';
import {
  apiDb,
  buildAuthorityWorld,
  declaredNoParticipation,
  maintenanceDb,
  type AuthorityWorld,
} from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { rebuildResultProjections, snapshotResultProjections } from './projections';
import { hashResultContent, ResultLedger } from './result-ledger';
import { inTransaction, ModuleRole } from './tx';
import { verifyStreamChain } from './ledger';

const db = apiDb();
const maintenance = maintenanceDb();
const store = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
const ledger = new ResultLedger(db, { conflictChecker: declaredNoParticipation });
let w: AuthorityWorld;

beforeAll(async () => {
  w = await buildAuthorityWorld(store, 'results');
});
afterAll(async () => {
  await db.destroy();
  await maintenance.destroy();
});

const P1 = '0190f4c2-3b7a-7c21-9d4e-5f6a7b8c9d02';
const P2 = '0190f4c2-3b7a-7c21-9d4e-5f6a7b8c9d03';
const content = (games = ['6', '3']) => ({
  entries: [
    {
      participantId: P2,
      outcome: 'LOSS',
      primaryMark: { metricId: 'padel.match.sets', value: '1', unit: 'sets', precision: 0 },
    },
    {
      participantId: P1,
      outcome: 'WIN',
      primaryMark: { metricId: 'padel.match.sets', value: '2', unit: 'sets', precision: 0 },
    },
  ],
  performances: games.map((g, i) => ({
    participantId: P1,
    ordinal: i + 1,
    mark: { metricId: 'padel.set.games', value: g, unit: 'games', precision: 0 },
  })),
});

async function newResultWithDraft(c = content()) {
  const result = await ledger.createResult({ scopeType: 'CONTEST', scopeTargetId: newId() });
  const { draftId } = await ledger.saveDraft({
    resultId: result.id,
    authorPrincipalId: w.official.id,
    disciplineVersionRef: 'padel.doubles@1',
    content: c,
  });
  return { result, draftId };
}

async function outboxFor(aggregateId: string) {
  return inTransaction(db, ModuleRole.results, (ctx) =>
    ctx.trx
      .selectFrom('platform.outbox_event')
      .selectAll()
      .where('aggregate_id', '=', aggregateId)
      .orderBy('id')
      .execute(),
  );
}

describe('result ledger', () => {
  it('submits a draft into an immutable, deterministically hashed ResultVersion with ledger, projection and outbox in one transaction', async () => {
    const { result, draftId } = await newResultWithDraft();
    const out = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `submit-${newId()}`,
    });
    expect(out.created).toBe(true);
    expect(out.versionNumber).toBe(1);
    expect(out.status).toBe('SUBMITTED');
    expect(out.contentHash).toBe(hashResultContent(content()).contentHash);
    // entry order in the draft does not matter: the entries set is canonically sorted
    expect(out.contentHash).toBe(
      hashResultContent({ ...content(), entries: [...content().entries].reverse() }).contentHash,
    );
    expect(out.ledgerEntries.map((e) => e.event_type)).toEqual([
      'RESULT_VERSION_SUBMITTED',
      'STATUS_TRANSITION',
    ]);
    expect(out.ledgerEntries.map((e) => e.sequence)).toEqual([2, 3]); // 1 = RESULT_CREATED

    const read = await ledger.getVersion(out.resultVersionId);
    expect(read?.state?.current_status).toBe('SUBMITTED');
    expect(read?.version.content_hash).toBe(out.contentHash);
    const events = await outboxFor(out.resultVersionId);
    expect(events.map((e) => e.event_type)).toEqual(['ResultSubmitted']);
    const chain = await inTransaction(db, ModuleRole.results, (ctx) =>
      verifyStreamChain(ctx, result.id),
    );
    expect(chain).toMatchObject({ ok: true, entries: 3 });
  });

  it('accepts SUBMITTED → PROVISIONAL, updating the projection and emitting an event', async () => {
    const { result, draftId } = await newResultWithDraft();
    const sub = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `submit-${newId()}`,
    });
    const acc = await ledger.transition({
      resultVersionId: sub.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `accept-${newId()}`,
    });
    expect(acc.status).toBe('PROVISIONAL');
    expect((await ledger.getResultState(result.id))?.current_version_id).toBe(sub.resultVersionId);
    expect((await outboxFor(sub.resultVersionId)).map((e) => e.event_type)).toEqual([
      'ResultSubmitted',
      'ResultProvisional',
    ]);
    await expect(
      ledger.transition({
        resultVersionId: sub.resultVersionId,
        toStatus: 'REJECTED',
        actorPrincipalId: w.official.id,
        scope: w.contestScope,
        idempotencyKey: `reject-${newId()}`,
      }),
    ).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('idempotency: same key + same request replays; same key + different request is rejected', async () => {
    const { draftId } = await newResultWithDraft();
    const key = `submit-${newId()}`;
    const a = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: key,
    });
    const b = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: key,
    });
    expect(b.resultVersionId).toBe(a.resultVersionId);
    expect(b.created).toBe(false);
    await expect(
      ledger.submitDraft({
        draftId,
        actorPrincipalId: w.official.id,
        scope: { ...w.contestScope, sport: ['padel', 'tennis'] },
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/);
  });

  it('duplicate content for the same Result creates no new version and no ledger consequence', async () => {
    const { result, draftId } = await newResultWithDraft();
    const first = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    const { draftId: draft2 } = await ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: w.official.id,
      disciplineVersionRef: 'padel.doubles@1',
      content: content(),
    });
    const second = await ledger.submitDraft({
      draftId: draft2,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    expect(second.created).toBe(false);
    expect(second.resultVersionId).toBe(first.resultVersionId);
    const chain = await inTransaction(db, ModuleRole.results, (ctx) =>
      verifyStreamChain(ctx, result.id),
    );
    expect(chain.entries).toBe(3);
  });

  it('submitted content never mutates: drafts lock, direct UPDATE is denied, a change needs a new version', async () => {
    const { result, draftId } = await newResultWithDraft();
    const v1 = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    await expect(ledger.updateDraft({ draftId, content: content(['7', '5']) })).rejects.toThrow(
      /IMMUTABLE/,
    );
    await expect(
      inTransaction(db, ModuleRole.results, (ctx) =>
        sql`UPDATE results.result_version SET content = '{}' WHERE id = ${v1.resultVersionId}`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    const { draftId: d2 } = await ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: w.official.id,
      disciplineVersionRef: 'padel.doubles@1',
      content: content(['7', '5']),
    });
    const v2 = await ledger.submitDraft({
      draftId: d2,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    expect(v2.versionNumber).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);
    const stored = await ledger.getVersion(v1.resultVersionId);
    expect(stored?.version.content_hash).toBe(v1.contentHash);
  });

  it('only one version per Result can be current (R-2); supersession needs a correction', async () => {
    const { result, draftId } = await newResultWithDraft();
    const v1 = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    await ledger.transition({
      resultVersionId: v1.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `a-${newId()}`,
    });
    const { draftId: d2 } = await ledger.saveDraft({
      resultId: result.id,
      authorPrincipalId: w.official.id,
      disciplineVersionRef: 'padel.doubles@1',
      content: content(['6', '4']),
    });
    const v2 = await ledger.submitDraft({
      draftId: d2,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    await expect(
      ledger.transition({
        resultVersionId: v2.resultVersionId,
        toStatus: 'PROVISIONAL',
        actorPrincipalId: w.official.id,
        scope: w.contestScope,
        idempotencyKey: `a-${newId()}`,
      }),
    ).rejects.toThrow(/CURRENT_VERSION_CONFLICT/);
  });

  it('an unauthorized principal cannot submit or accept', async () => {
    const { draftId } = await newResultWithDraft();
    await expect(
      ledger.submitDraft({
        draftId,
        actorPrincipalId: w.outsider.id,
        scope: w.contestScope,
        idempotencyKey: `s-${newId()}`,
      }),
    ).rejects.toThrow(/AUTHORITY_DENIED/);
    const v = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    await expect(
      ledger.transition({
        resultVersionId: v.resultVersionId,
        toStatus: 'PROVISIONAL',
        actorPrincipalId: w.official.id,
        scope: { ...w.contestScope, contest: [newId()] },
        idempotencyKey: `a-${newId()}`,
      }),
    ).rejects.toThrow(/AUTHORITY_DENIED: authority denied: SCOPE_NOT_COVERED/);
  });

  it('projections rebuild from ledger history to exactly the same state', async () => {
    const { draftId } = await newResultWithDraft();
    const v = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    await ledger.transition({
      resultVersionId: v.resultVersionId,
      toStatus: 'PROVISIONAL',
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `a-${newId()}`,
    });
    const { draftId: rejectedDraft } = await newResultWithDraft(content(['1', '1']));
    const r = await ledger.submitDraft({
      draftId: rejectedDraft,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    await ledger.transition({
      resultVersionId: r.resultVersionId,
      toStatus: 'REJECTED',
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `x-${newId()}`,
      reason: 'score sheet mismatch',
    });

    const before = await snapshotResultProjections(db);
    const stats = await rebuildResultProjections(maintenance); // maintenance login only
    const after = await snapshotResultProjections(db);
    expect(stats.entries).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });

  it('a participant in the contest cannot accept its result (conflict), and without participation data acceptance fails closed', async () => {
    const { draftId } = await newResultWithDraft();
    const v = await ledger.submitDraft({
      draftId,
      actorPrincipalId: w.official.id,
      scope: w.contestScope,
      idempotencyKey: `s-${newId()}`,
    });
    const participant = new ResultLedger(db, {
      conflictChecker: staticParticipationChecker(
        [{ principalId: w.official.id, scope: { contest: [w.contestId] } }],
        'test-official-plays',
      ),
    });
    await expect(
      participant.transition({
        resultVersionId: v.resultVersionId,
        toStatus: 'PROVISIONAL',
        actorPrincipalId: w.official.id,
        scope: w.contestScope,
        idempotencyKey: `a-${newId()}`,
      }),
    ).rejects.toThrow(/CONFLICT_OF_INTEREST/);
    const bare = new ResultLedger(db);
    await expect(
      bare.transition({
        resultVersionId: v.resultVersionId,
        toStatus: 'PROVISIONAL',
        actorPrincipalId: w.official.id,
        scope: w.contestScope,
        idempotencyKey: `a-${newId()}`,
      }),
    ).rejects.toThrow(/CONFLICT_CHECK_UNAVAILABLE/);
    // submission (exempt) still works without participation data
    const { draftId: d2 } = await newResultWithDraft();
    await expect(
      bare.submitDraft({
        draftId: d2,
        actorPrincipalId: w.official.id,
        scope: w.contestScope,
        idempotencyKey: `s-${newId()}`,
      }),
    ).resolves.toMatchObject({ created: true });
    expect((await ledger.getVersion(v.resultVersionId))?.state?.current_status).toBe('SUBMITTED');
  });

  describe('idempotency under concurrency (BRT-03R)', () => {
    async function consequences(resultId: string, versionIds: string[], key: string) {
      return inTransaction(db, ModuleRole.results, async (ctx) => ({
        versions: (
          await ctx.trx
            .selectFrom('results.result_version')
            .select('id')
            .where('result_id', '=', resultId)
            .execute()
        ).length,
        ledger: (
          await ctx.trx
            .selectFrom('platform.ledger_entry')
            .select('id')
            .where('stream_id', '=', resultId)
            .execute()
        ).length,
        events:
          versionIds.length === 0
            ? 0
            : (
                await ctx.trx
                  .selectFrom('platform.outbox_event')
                  .select('id')
                  .where('aggregate_id', 'in', versionIds)
                  .execute()
              ).length,
        idem: (
          await ctx.trx
            .selectFrom('platform.command_idempotency')
            .select('idempotency_key')
            .where('idempotency_key', '=', key)
            .execute()
        ).length,
      }));
    }

    it('A: 20 concurrent identical submissions with one key → one version, one ledger consequence, same result everywhere', async () => {
      const { result, draftId } = await newResultWithDraft();
      const key = `submit-${newId()}`;
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          ledger.submitDraft({
            draftId,
            actorPrincipalId: w.official.id,
            scope: w.contestScope,
            idempotencyKey: key,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<ResultLedger['submitDraft']>>
      >[];
      expect(ok).toHaveLength(20);
      expect(new Set(ok.map((r) => r.value.resultVersionId)).size).toBe(1);
      expect(new Set(ok.map((r) => r.value.contentHash)).size).toBe(1);
      expect(ok.filter((r) => r.value.created)).toHaveLength(1);
      const c = await consequences(result.id, [ok[0]!.value.resultVersionId], key);
      expect(c).toEqual({ versions: 1, ledger: 3, events: 1, idem: 1 }); // RESULT_CREATED + VERSION + T2
    });

    it('B: concurrent different submissions with one key → exactly one establishes it; losers leave no effects', async () => {
      const { result, draftId: d1 } = await newResultWithDraft();
      const { draftId: d2 } = await ledger.saveDraft({
        resultId: result.id,
        authorPrincipalId: w.official.id,
        disciplineVersionRef: 'padel.doubles@1',
        content: content(['7', '5']),
      });
      const key = `submit-${newId()}`;
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          ledger.submitDraft({
            draftId: i % 2 === 0 ? d1 : d2,
            actorPrincipalId: w.official.id,
            scope: w.contestScope,
            idempotencyKey: key,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
        Awaited<ReturnType<ResultLedger['submitDraft']>>
      >[];
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(ok).toHaveLength(6);
      expect(new Set(ok.map((r) => r.value.resultVersionId)).size).toBe(1);
      expect(failed).toHaveLength(6);
      for (const f of failed) expect(String(f.reason)).toMatch(/IDEMPOTENCY_KEY_REUSED/);
      const c = await consequences(result.id, [ok[0]!.value.resultVersionId], key);
      expect(c).toEqual({ versions: 1, ledger: 3, events: 1, idem: 1 });
      // the losing draft was not marked submitted
      const drafts = await inTransaction(db, ModuleRole.results, (ctx) =>
        ctx.trx
          .selectFrom('results.result_draft')
          .select(['id', 'submitted_version_id'])
          .where('result_id', '=', result.id)
          .execute(),
      );
      expect(drafts.filter((d) => d.submitted_version_id !== null)).toHaveLength(1);
    });
  });
});
