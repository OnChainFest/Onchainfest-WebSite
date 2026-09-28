import { newId, type AuthorityScope } from '@br/domain';
import { apiDb, buildAuthorityWorld, declaredNoParticipation, sleep } from '@br/testkit';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { AuthorityStore } from './authority-store';
import { inTransaction, ModuleRole } from './tx';

const db = apiDb();
const store = new AuthorityStore(db, { conflictChecker: declaredNoParticipation });
afterAll(() => db.destroy());

describe('authority persistence and evaluation', () => {
  it('builds a scoped chain and authorizes a valid capability with a proof', async () => {
    const w = await buildAuthorityWorld(store, 'chain');
    const d = await store.authorize({
      principalId: w.official.id,
      capability: 'ACCEPT_RESULT',
      scope: w.contestScope,
    });
    expect(d.authorized).toBe(true);
    expect(d.grantChain.map((l) => l.grantId)).toEqual([w.officialGrant.id, w.organizerGrant.id]);
    expect(d.anchorId).toBe(w.platformAnchorId);
    expect(d.proofDigest).toMatch(/^sha256:/);
  });

  it('fails an unauthorized principal, a foreign contest and a non-delegated capability', async () => {
    const w = await buildAuthorityWorld(store, 'deny');
    expect(
      (
        await store.authorize({
          principalId: w.outsider.id,
          capability: 'ACCEPT_RESULT',
          scope: w.contestScope,
        })
      ).reason,
    ).toBe('NO_GRANT_FOR_CAPABILITY');
    const otherContest: AuthorityScope = { ...w.contestScope, contest: [newId()] };
    expect(
      (
        await store.authorize({
          principalId: w.official.id,
          capability: 'ACCEPT_RESULT',
          scope: otherContest,
        })
      ).reason,
    ).toBe('SCOPE_NOT_COVERED');
    expect(
      (
        await store.authorize({
          principalId: w.official.id,
          capability: 'DECLARE_OFFICIAL',
          scope: w.contestScope,
        })
      ).reason,
    ).toBe('NO_GRANT_FOR_CAPABILITY');
  });

  it('rejects a widened child grant at issuance', async () => {
    const w = await buildAuthorityWorld(store, 'widen');
    await expect(
      store.issueGrant({
        actorPrincipalId: w.organizer.id,
        grantorPrincipalId: w.organizer.id,
        granteePrincipalId: w.outsider.id,
        parentGrantId: w.organizerGrant.id,
        capabilities: ['ACCEPT_RESULT'],
        scope: { sport: ['padel'], recognitionLevel: ['PLATFORM'] },
        delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      }),
    ).rejects.toThrow(/GRANT_INVALID: grant rejected: SCOPE_WIDENED/);
  });

  it('rejects an empty scope set instead of silently widening it to "unconstrained"', async () => {
    const w = await buildAuthorityWorld(store, 'empty');
    await expect(
      store.issueGrant({
        actorPrincipalId: w.organizer.id,
        grantorPrincipalId: w.organizer.id,
        granteePrincipalId: w.outsider.id,
        parentGrantId: w.organizerGrant.id,
        capabilities: ['ACCEPT_RESULT'],
        scope: { ...w.contestScope, contest: [] },
        delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      }),
    ).rejects.toThrow(/BRJ_SCHEMA_CONSTRAINT/);
  });

  it('grants cannot be backdated — in the application and in the database', async () => {
    const w = await buildAuthorityWorld(store, 'backdate');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await expect(
      store.issueGrant({
        actorPrincipalId: w.organizer.id,
        grantorPrincipalId: w.organizer.id,
        granteePrincipalId: w.outsider.id,
        parentGrantId: w.organizerGrant.id,
        capabilities: ['ACCEPT_RESULT'],
        scope: w.contestScope,
        delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
        effectiveFrom: past,
      }),
    ).rejects.toThrow(/BACKDATING_REJECTED/);
    // Bypassing the application: the CHECK constraint still refuses it.
    await expect(
      inTransaction(db, ModuleRole.authority, (ctx) =>
        sql`INSERT INTO authority.authority_grant (id, grantor_principal_id, grantee_principal_id, capabilities, scope, delegation, constraints, effective_from, grant_hash, recorded_at)
            VALUES (${newId()}, ${w.organizer.id}, ${w.outsider.id}, ARRAY['ACCEPT_RESULT'], '{}', '{}', '{}', ${past}, ${`sha256:${'c'.repeat(64)}`}, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('duplicate grant commands produce no duplicate grant; reusing an idempotency key for a different grant is rejected', async () => {
    const w = await buildAuthorityWorld(store, 'dup');
    const cmd = {
      actorPrincipalId: w.organizer.id,
      grantorPrincipalId: w.organizer.id,
      granteePrincipalId: w.outsider.id,
      parentGrantId: w.organizerGrant.id,
      capabilities: ['SUBMIT_RESULT'] as const,
      scope: w.contestScope,
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      effectiveFrom: new Date(Date.now() + 1000),
      idempotencyKey: `grant-${newId()}`,
    };
    const first = await store.issueGrant(cmd);
    const second = await store.issueGrant(cmd);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.grant.id).toBe(first.grant.id);
    const noKey = await store.issueGrant({ ...cmd, idempotencyKey: `grant-${newId()}` });
    expect(noKey.grant.id).toBe(first.grant.id); // same grant hash ⇒ same grant
    await expect(store.issueGrant({ ...cmd, capabilities: ['ACCEPT_RESULT'] })).rejects.toThrow(
      /IDEMPOTENCY_KEY_REUSED/,
    );
  });

  it('revoked and expired grants fail', async () => {
    const w = await buildAuthorityWorld(store, 'revoke');
    const { grant: shortLived } = await store.issueGrant({
      actorPrincipalId: w.organizer.id,
      grantorPrincipalId: w.organizer.id,
      granteePrincipalId: w.outsider.id,
      parentGrantId: w.organizerGrant.id,
      capabilities: ['SUBMIT_RESULT'],
      scope: w.contestScope,
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      effectiveTo: new Date(Date.now() + 60_000),
    });
    const expiry = shortLived.effectiveTo as Date;
    const q = {
      principalId: w.outsider.id,
      capability: 'SUBMIT_RESULT' as const,
      scope: w.contestScope,
    };
    // Deterministic (no wall-clock race): evaluate at explicit effective times around the
    // stored validity window [effectiveFrom, effectiveTo).
    expect(
      (await store.authorize({ ...q, atTime: new Date(expiry.getTime() - 1) })).authorized,
    ).toBe(true);
    expect((await store.authorize({ ...q, atTime: expiry })).reason).toBe(
      'GRANT_NOT_VALID_AT_TIME',
    );

    await store.revokeGrant({
      grantId: w.organizerGrant.id,
      actorPrincipalId: w.platform.id,
      reason: 'engagement ended',
    });
    // cascade by evaluation: the official's child grant now fails too
    expect(
      (
        await store.authorize({
          principalId: w.official.id,
          capability: 'ACCEPT_RESULT',
          scope: w.contestScope,
        })
      ).reason,
    ).toBe('GRANT_REVOKED');
    await expect(
      store.revokeGrant({
        grantId: w.officialGrant.id,
        actorPrincipalId: w.outsider.id,
        reason: 'not mine',
      }),
    ).rejects.toThrow(/AUTHORITY_DENIED/);
  });

  it('compromised key: retroactive distrust as known now, good faith as known then', async () => {
    const w = await buildAuthorityWorld(store, 'key');
    const { keyId } = await store.registerKey({
      principalId: w.official.id,
      keyKind: 'PASSKEY',
      algorithm: 'ES256',
      verificationMaterial: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    });
    await sleep(50);
    const beforeT0 = new Date();
    await sleep(50);
    const t0 = new Date();
    await sleep(50);
    const afterT0 = new Date();
    await sleep(50);
    const beforeDeclaration = new Date();
    await sleep(50);
    await store.changeKeyStatus({
      keyId,
      kind: 'COMPROMISED',
      compromisedSince: t0,
      reason: 'device stolen',
    });
    const base = {
      principalId: w.official.id,
      keyId,
      capability: 'ACCEPT_RESULT' as const,
      scope: w.contestScope,
    };
    expect((await store.authorize({ ...base, atTime: beforeT0 })).authorized).toBe(true);
    expect((await store.authorize({ ...base, atTime: afterT0 })).reason).toBe('KEY_COMPROMISED');
    expect(
      (await store.authorize({ ...base, atTime: afterT0, asOf: beforeDeclaration })).authorized,
    ).toBe(true);
    expect((await store.authorize({ ...base, atTime: beforeT0, signedAt: afterT0 })).reason).toBe(
      'KEY_COMPROMISED',
    );
  });

  it('private key material is never stored', async () => {
    const w = await buildAuthorityWorld(store, 'priv');
    await expect(
      store.registerKey({
        principalId: w.official.id,
        keyKind: 'JWK',
        algorithm: 'ES256',
        verificationMaterial: { kty: 'EC', d: 'secret' },
      }),
    ).rejects.toThrow(/private key material/);
    await expect(
      inTransaction(db, ModuleRole.authority, (ctx) =>
        sql`INSERT INTO authority.principal_key (id, principal_id, key_kind, algorithm, verification_material, effective_from, fact_hash, recorded_at)
            VALUES (${newId()}, ${w.official.id}, 'JWK', 'ES256', '{"kty":"EC","mnemonic":"abandon abandon"}', ${ctx.txTime}, ${`sha256:${'d'.repeat(64)}`}, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the PLATFORM principal can never be recognized beyond the PLATFORM level', async () => {
    const platform = await store.registerPrincipal({
      principalType: 'PLATFORM',
      label: 'platform (anchor test)',
    });
    await expect(
      store.recognizeTrustAnchor({
        principalId: platform.id,
        recognitionScope: { recognitionLevel: ['NATIONAL'] },
        basisRef: 'x',
        governanceDecisionRef: 'x',
      }),
    ).rejects.toThrow(/ANCHOR_INVALID/);
    await expect(
      inTransaction(db, ModuleRole.authority, (ctx) =>
        sql`INSERT INTO authority.trust_anchor (id, principal_id, recognition_scope, basis_ref, governance_decision_ref, effective_from, fact_hash, recorded_at)
            VALUES (${newId()}, ${platform.id}, '{"recognitionLevel":["WORLD"]}', 'x', 'x', ${ctx.txTime}, ${`sha256:${'e'.repeat(64)}`}, ${ctx.txTime})`.execute(
          ctx.trx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'BR010' });
  });
});

/** DB transaction time (ms precision) — the trusted platform clock used for recordedAt. */
async function dbNow(): Promise<Date> {
  return inTransaction(db, ModuleRole.authority, async (ctx) => ctx.txTime);
}

const H = () => `sha256:${newId().replaceAll('-', '').padEnd(64, '0')}`;

describe('strict no-backdating at the exact transaction-time boundary (BRT-03R)', () => {
  // Each insert runs in its own transaction; offsets are relative to that transaction's time.
  const tryInsert = (offsetMs: number, build: (t: Date, eff: Date) => ReturnType<typeof sql>) =>
    inTransaction(db, ModuleRole.authority, (ctx) =>
      build(ctx.txTime, new Date(ctx.txTime.getTime() + offsetMs)).execute(ctx.trx),
    );

  it('authority_grant: = tx time accept, > tx time accept, < tx time reject', async () => {
    const w = await buildAuthorityWorld(store, 'boundary-grant');
    const grantAt = (offset: number) =>
      tryInsert(
        offset,
        (
          t,
          eff,
        ) => sql`INSERT INTO authority.authority_grant (id, grantor_principal_id, grantee_principal_id, capabilities, scope, delegation, constraints, effective_from, grant_hash, recorded_at)
          VALUES (${newId()}, ${w.organizer.id}, ${w.outsider.id}, ARRAY['ACCEPT_RESULT'], '{}', '{}', '{}', ${eff}, ${H()}, ${t})`,
      );
    await expect(grantAt(0)).resolves.toBeDefined();
    await expect(grantAt(1)).resolves.toBeDefined();
    await expect(grantAt(-1)).rejects.toMatchObject({ code: '23514' });
  });

  it('principal_key and trust_anchor follow the same strict rule', async () => {
    const p = await store.registerPrincipal({
      principalType: 'ORGANIZATION',
      label: 'boundary org',
    });
    const keyAt = (offset: number) =>
      tryInsert(
        offset,
        (
          t,
          eff,
        ) => sql`INSERT INTO authority.principal_key (id, principal_id, key_kind, algorithm, verification_material, effective_from, fact_hash, recorded_at)
          VALUES (${newId()}, ${p.id}, 'JWK', 'ES256', '{"kty":"EC"}', ${eff}, ${H()}, ${t})`,
      );
    await expect(keyAt(0)).resolves.toBeDefined();
    await expect(keyAt(1)).resolves.toBeDefined();
    await expect(keyAt(-1)).rejects.toMatchObject({ code: '23514' });
    const anchorAt = (offset: number) =>
      tryInsert(
        offset,
        (
          t,
          eff,
        ) => sql`INSERT INTO authority.trust_anchor (id, principal_id, recognition_scope, basis_ref, governance_decision_ref, effective_from, fact_hash, recorded_at)
          VALUES (${newId()}, ${p.id}, '{"recognitionLevel":["CLUB"]}', 'x', 'x', ${eff}, ${H()}, ${t})`,
      );
    await expect(anchorAt(0)).resolves.toBeDefined();
    await expect(anchorAt(1)).resolves.toBeDefined();
    await expect(anchorAt(-1)).rejects.toMatchObject({ code: '23514' });
  });

  it('ordinary revocation is strictly prospective; compromise remains the explicit retroactive exception', async () => {
    const w = await buildAuthorityWorld(store, 'boundary-revoke');
    const revokeAt = (offset: number, compromise: boolean) =>
      tryInsert(
        offset,
        (
          t,
          eff,
        ) => sql`INSERT INTO authority.authority_grant_status_change (id, grant_id, kind, compromise, effective_from, reason, fact_hash, recorded_at)
          VALUES (${newId()}, ${w.officialGrant.id}, 'REVOKED', ${compromise}, ${eff}, 'test', ${H()}, ${t})`,
      );
    await expect(revokeAt(-1, false)).rejects.toMatchObject({ code: '23514' });
    await expect(revokeAt(0, false)).resolves.toBeDefined();
    await expect(revokeAt(-60_000, true)).resolves.toBeDefined(); // compromise: retroactive by design
    await expect(revokeAt(1, true)).rejects.toMatchObject({ code: '23514' }); // but never in the future
  });

  it('application: default effectiveFrom = issuance time; any earlier DB time is rejected; future is accepted', async () => {
    const w = await buildAuthorityWorld(store, 'boundary-app');
    const base = {
      actorPrincipalId: w.organizer.id,
      grantorPrincipalId: w.organizer.id,
      granteePrincipalId: w.outsider.id,
      parentGrantId: w.organizerGrant.id,
      capabilities: ['SUBMIT_RESULT'] as const,
      scope: w.contestScope,
      delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
    };
    const { grant } = await store.issueGrant(base);
    expect(grant.effectiveFrom.getTime()).toBe(grant.recordedAt.getTime());
    // A DB time strictly before the issuing transaction (transaction times are monotonic).
    const before = new Date((await dbNow()).getTime() - 1);
    await expect(
      store.issueGrant({ ...base, capabilities: ['ACCEPT_RESULT'], effectiveFrom: before }),
    ).rejects.toThrow(/BACKDATING_REJECTED/);
    const future = new Date((await dbNow()).getTime() + 60_000);
    await expect(
      store.issueGrant({ ...base, capabilities: ['ACCEPT_RESULT'], effectiveFrom: future }),
    ).resolves.toMatchObject({ created: true });
  });
});

describe('conflict of interest fails closed without participation data (BRT-03R)', () => {
  it('a store without a checker cannot issue grants or authorize conflict-sensitive capabilities', async () => {
    const w = await buildAuthorityWorld(store, 'fail-closed');
    const bare = new AuthorityStore(db); // no participation data source
    await expect(
      bare.issueGrant({
        actorPrincipalId: w.organizer.id,
        grantorPrincipalId: w.organizer.id,
        granteePrincipalId: w.outsider.id,
        parentGrantId: w.organizerGrant.id,
        capabilities: ['SUBMIT_RESULT'],
        scope: w.contestScope,
        delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
      }),
    ).rejects.toThrow(/CONFLICT_CHECK_UNAVAILABLE/);
    const d = await bare.authorize({
      principalId: w.official.id,
      capability: 'ACCEPT_RESULT',
      scope: w.contestScope,
    });
    expect(d).toMatchObject({
      authorized: false,
      reason: 'CONFLICT_CHECK_UNAVAILABLE',
      conflictCheck: 'UNAVAILABLE',
      conflictCheckerId: 'participation-index-unavailable',
    });
    const submit = await bare.authorize({
      principalId: w.official.id,
      capability: 'SUBMIT_RESULT',
      scope: w.contestScope,
    });
    expect(submit).toMatchObject({ authorized: true, conflictCheck: 'NOT_APPLICABLE' });
  });
});

describe('idempotency under concurrency (BRT-03R)', () => {
  async function countsFor(grantHash: string, key?: string) {
    return inTransaction(db, ModuleRole.authority, async (ctx) => {
      const grants = await ctx.trx
        .selectFrom('authority.authority_grant')
        .select('id')
        .where('grant_hash', '=', grantHash)
        .execute();
      const ids = grants.map((g) => g.id);
      const ledger =
        ids.length === 0
          ? []
          : await ctx.trx
              .selectFrom('platform.ledger_entry')
              .select('id')
              .where('stream_id', 'in', ids)
              .execute();
      const events =
        ids.length === 0
          ? []
          : await ctx.trx
              .selectFrom('platform.outbox_event')
              .select('id')
              .where('aggregate_id', 'in', ids)
              .execute();
      const idem =
        key === undefined
          ? []
          : await ctx.trx
              .selectFrom('platform.command_idempotency')
              .select('idempotency_key')
              .where('idempotency_key', '=', key)
              .execute();
      return {
        grants: grants.length,
        ledger: ledger.length,
        events: events.length,
        idem: idem.length,
        ids,
      };
    });
  }

  async function cmdFor(label: string) {
    const w = await buildAuthorityWorld(store, label);
    const effectiveFrom = new Date((await dbNow()).getTime() + 3_600_000); // identical request across callers
    return {
      w,
      cmd: {
        actorPrincipalId: w.organizer.id,
        grantorPrincipalId: w.organizer.id,
        granteePrincipalId: w.outsider.id,
        parentGrantId: w.organizerGrant.id,
        capabilities: ['SUBMIT_RESULT'] as ('SUBMIT_RESULT' | 'ACCEPT_RESULT')[],
        scope: w.contestScope,
        delegation: { allowed: false, maxDepth: 0, capabilitiesDelegable: [] },
        effectiveFrom,
      },
    };
  }

  it('A: 20 concurrent identical requests with one key → one effect, one record, same result for all', async () => {
    const { cmd } = await cmdFor('idem-a');
    const key = `grant-${newId()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.issueGrant({ ...cmd, idempotencyKey: key })),
    );
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<AuthorityStore['issueGrant']>>> =>
        r.status === 'fulfilled',
    );
    expect(ok).toHaveLength(20);
    expect(new Set(ok.map((r) => r.value.grant.id)).size).toBe(1);
    expect(ok.filter((r) => r.value.created)).toHaveLength(1);
    const c = await countsFor(ok[0]!.value.grant.grantHash, key);
    expect({ grants: c.grants, ledger: c.ledger, events: c.events, idem: c.idem }).toEqual({
      grants: 1,
      ledger: 1,
      events: 1,
      idem: 1,
    });
  });

  it('A′: 20 concurrent identical requests without a key → still exactly one grant (natural-key retry)', async () => {
    const { cmd } = await cmdFor('idem-a2');
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => store.issueGrant(cmd)),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const values = results.map(
      (r) => (r as PromiseFulfilledResult<Awaited<ReturnType<AuthorityStore['issueGrant']>>>).value,
    );
    expect(new Set(values.map((v) => v.grant.id)).size).toBe(1);
    const c = await countsFor(values[0]!.grant.grantHash);
    expect({ grants: c.grants, ledger: c.ledger, events: c.events }).toEqual({
      grants: 1,
      ledger: 1,
      events: 1,
    });
  });

  it('B: concurrent different requests with one key → one establishes it, the rest are rejected, no partial effects', async () => {
    const { cmd } = await cmdFor('idem-b');
    const key = `grant-${newId()}`;
    const variants = Array.from({ length: 16 }, (_, i) => ({
      ...cmd,
      capabilities: [i % 2 === 0 ? 'SUBMIT_RESULT' : 'ACCEPT_RESULT'] as (
        'SUBMIT_RESULT' | 'ACCEPT_RESULT'
      )[],
      idempotencyKey: key,
    }));
    const results = await Promise.allSettled(variants.map((v) => store.issueGrant(v)));
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<AuthorityStore['issueGrant']>>
    >[];
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(8); // every caller with the winning request replays it
    expect(new Set(ok.map((r) => r.value.grant.id)).size).toBe(1);
    expect(failed.length).toBe(8);
    for (const f of failed) expect(String(f.reason)).toMatch(/IDEMPOTENCY_KEY_REUSED/);
    const winnerCaps = ok[0]!.value.grant.capabilities;
    const loser = {
      ...cmd,
      capabilities: [winnerCaps[0] === 'SUBMIT_RESULT' ? 'ACCEPT_RESULT' : 'SUBMIT_RESULT'] as (
        'SUBMIT_RESULT' | 'ACCEPT_RESULT'
      )[],
    };
    // The losing request's grant document was never persisted (no partial effects survived).
    const { canonicalHash } = await import('./hashing');
    const { DomainTag, SchemaRef } = await import('@br/schemas');
    const loserHash = canonicalHash(DomainTag.authorityGrant, SchemaRef.authorityGrant, {
      grantorPrincipalId: loser.grantorPrincipalId,
      granteePrincipalId: loser.granteePrincipalId,
      parentGrantId: loser.parentGrantId,
      capabilities: loser.capabilities,
      scope: loser.scope,
      delegation: loser.delegation,
      constraints: { mustNotBeParticipant: true },
      effectiveFrom: loser.effectiveFrom.toISOString(),
    }).contentHash;
    // sanity: the same construction reproduces the winner's stored hash
    expect(
      canonicalHash(DomainTag.authorityGrant, SchemaRef.authorityGrant, {
        grantorPrincipalId: cmd.grantorPrincipalId,
        granteePrincipalId: cmd.granteePrincipalId,
        parentGrantId: cmd.parentGrantId,
        capabilities: winnerCaps,
        scope: cmd.scope,
        delegation: cmd.delegation,
        constraints: { mustNotBeParticipant: true },
        effectiveFrom: cmd.effectiveFrom.toISOString(),
      }).contentHash,
    ).toBe(ok[0]!.value.grant.grantHash);
    expect((await countsFor(loserHash)).grants).toBe(0);
    const winner = await countsFor(ok[0]!.value.grant.grantHash, key);
    expect({
      grants: winner.grants,
      ledger: winner.ledger,
      events: winner.events,
      idem: winner.idem,
    }).toEqual({ grants: 1, ledger: 1, events: 1, idem: 1 });
  });
});
