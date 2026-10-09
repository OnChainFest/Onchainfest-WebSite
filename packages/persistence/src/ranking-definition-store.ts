import type { DisciplineVersionSpec } from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  newId,
  RANKING_SYSTEM_KINDS,
  type RecognitionScope,
  type Uuid,
} from '@br/domain';
import {
  RECOGNITION_WORDS,
  rankingSystemVersionContinues,
  validateClassificationPolicySpec,
  validateRankingSystemSpec,
  type ClassificationPolicySpec,
  type RankingDisciplineContext,
  type RankingOwnerContext,
  type RankingSystemSpec,
  type SpecIssue,
} from '@br/rankings';
import { sql } from 'kysely';
import type { Db } from './db';
import { identityIdempotency, lockKeys, pgConstraint, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { refreshSystemCard } from './ranking-projection';
import { inTransaction, ModuleRole, type TxContext } from './tx';

const CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLASSIFICATION_SCOPES: readonly string[] = [
  'ROUND_CLASSIFICATION',
  'EVENT_CLASSIFICATION',
  'COMPETITION_CLASSIFICATION',
];

const rejected = (what: string, issues: readonly SpecIssue[]) =>
  new DomainError(DomainErrorCode.INVALID_INPUT, `${what} rejected`, { issues });

/** Free-text labels are labels only: never a recognition claim (ADR-0048 §7). */
function checkedName(name: string): string {
  const n = name.trim();
  if (n.length === 0 || n.length > 120)
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid name');
  if (RECOGNITION_WORDS.test(n))
    throw new DomainError(DomainErrorCode.INVALID_INPUT, 'a name may not claim recognition', {
      issues: [{ path: '/name', code: 'DISPLAY_NAME_CLAIMS_RECOGNITION' }],
    });
  return n;
}

/** The exact DisciplineVersion a definition pins (catalog data + status + sport / discipline codes). */
async function disciplineContext(
  ctx: TxContext,
  disciplineVersionId: string,
): Promise<RankingDisciplineContext | undefined> {
  if (!UUID.test(disciplineVersionId)) return undefined;
  const { rows } = await sql<{
    spec: DisciplineVersionSpec;
    status: string | null;
    sport: string;
    discipline: string;
  }>`
    SELECT v.spec, c.status, s.code AS sport, d.code AS discipline FROM sports.discipline_version v
    JOIN sports.discipline d ON d.id = v.discipline_id JOIN sports.sport s ON s.id = d.sport_id
    LEFT JOIN sports.v_discipline_version_current c ON c.discipline_version_id = v.id
    WHERE v.id = ${disciplineVersionId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    disciplineVersionId,
    status: (r.status ?? 'DRAFT') as RankingDisciplineContext['status'],
    sport: r.sport,
    discipline: r.discipline,
    spec: r.spec,
  };
}

/**
 * The OFFICIAL owner's trust-anchor fact, loaded canonically and only while CURRENTLY valid
 * (effective now, not expired, not REVOKED). Never asserted by the caller; a PLATFORM anchor never
 * owns an OFFICIAL system (BR172 + OFFICIAL_RECOGNITION_CANNOT_BE_PLATFORM).
 */
async function ownerContext(
  ctx: TxContext,
  owner: { readonly principalId: string; readonly anchorId: string },
): Promise<RankingOwnerContext | undefined> {
  if (!UUID.test(owner.anchorId) || !UUID.test(owner.principalId)) return undefined;
  const { rows } = await sql<{ principal_id: string; recognition_scope: RecognitionScope }>`
    SELECT a.principal_id, a.recognition_scope FROM authority.trust_anchor a
    WHERE a.id = ${owner.anchorId} AND a.effective_from <= ${ctx.txTime}
      AND (a.effective_to IS NULL OR a.effective_to > ${ctx.txTime})
      AND NOT EXISTS (SELECT 1 FROM authority.trust_anchor_status_change c
                      WHERE c.anchor_id = a.id AND c.kind = 'REVOKED' AND c.effective_from <= ${ctx.txTime})`.execute(
    ctx.trx,
  );
  const a = rows[0];
  if (a === undefined) return undefined;
  return {
    anchorId: owner.anchorId,
    principalId: a.principal_id,
    recognitionScope: a.recognition_scope,
  };
}

/** Validates a ranking system spec against its exact catalog and owner facts (never caller-asserted). */
async function validateSystemInContext(ctx: TxContext, spec: unknown) {
  const structural = validateRankingSystemSpec(spec);
  if (!structural.ok) throw rejected('ranking system spec', structural.issues);
  const s = structural.spec;
  const discipline = await disciplineContext(ctx, s.universe.disciplineVersionId);
  if (discipline === undefined)
    throw rejected('ranking system spec', [
      { path: '/universe/disciplineVersionId', code: 'DISCIPLINE_VERSION_UNKNOWN' },
    ]);
  let owner: RankingOwnerContext | undefined;
  if (s.owner !== undefined) {
    owner = await ownerContext(ctx, s.owner);
    if (owner === undefined)
      throw rejected('ranking system spec', [{ path: '/owner', code: 'OWNER_ANCHOR_UNKNOWN' }]);
  }
  const v = validateRankingSystemSpec(spec, {
    discipline,
    ...(owner === undefined ? {} : { owner }),
  });
  if (!v.ok) throw rejected('ranking system spec', v.issues);
  for (const competitionId of v.spec.universe.competitionIds ?? []) {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM competition.competition WHERE id = ${competitionId}`.execute(ctx.trx);
    if (rows[0] === undefined)
      throw rejected('ranking system spec', [
        { path: '/universe/competitionIds', code: 'COMPETITION_UNKNOWN' },
      ]);
  }
  return v;
}

async function validatePolicyInContext(ctx: TxContext, spec: unknown) {
  const structural = validateClassificationPolicySpec(spec);
  if (!structural.ok) throw rejected('classification policy spec', structural.issues);
  const discipline = await disciplineContext(ctx, structural.spec.disciplineVersionId);
  if (discipline === undefined)
    throw rejected('classification policy spec', [
      { path: '/disciplineVersionId', code: 'DISCIPLINE_VERSION_UNKNOWN' },
    ]);
  const v = validateClassificationPolicySpec(spec, discipline);
  if (!v.ok) throw rejected('classification policy spec', v.issues);
  return v;
}

const noBackdating = (effectiveFrom: string, txTime: Date) => {
  if (Date.parse(effectiveFrom) < txTime.getTime())
    throw new DomainError(
      DomainErrorCode.BACKDATING_REJECTED,
      'a ranking system version cannot take effect before it is published',
    );
};

/**
 * INTERNAL BRT-10 definition administration on the DEDICATED operator connection
 * (br_ranking_operator_app → br_ranking_rules only): ClassificationPolicy and RankingSystem
 * identities, immutable declarative versions (validated against the exact PUBLISHED DisciplineVersion
 * and, for OFFICIAL systems, the owner's CURRENTLY valid trust anchor — before any row exists), and
 * the append-only DRAFT → PUBLISHED → RETIRED lifecycle (never backdated). It cannot evaluate a run,
 * publish a snapshot, submit a classification, rank anyone or touch a sporting fact: the role has no
 * such privilege and there is no such method.
 */
export class RankingDefinitionStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.rankingRules, fn);
  }

  // ───────────────────────────── ClassificationPolicy ─────────────────────────────

  createClassificationPolicy(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    scopeType: string;
    idempotencyKey: string;
  }): Promise<{ policyId: string; created: boolean }> {
    try {
      if (!CODE.test(input.code))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid policy code');
      if (!CLASSIFICATION_SCOPES.includes(input.scopeType))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'unsupported classification scope');
      checkedName(input.name);
    } catch (err) {
      return Promise.reject(err);
    }
    const name = input.name.trim();
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ policyId: string }>(ctx, {
        command: 'CreateClassificationPolicy',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name, scopeType: input.scopeType },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `classification-policy-code:${input.code}`);
      const policyId = newId();
      try {
        await sql`INSERT INTO ranking.classification_policy (id, code, name, scope_type, created_by_account_id, recorded_at)
          VALUES (${policyId}, ${input.code}, ${name}, ${input.scopeType}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if (pgConstraint(err) !== undefined)
          throw new DomainError(DomainErrorCode.ALREADY_EXISTS, 'policy code already exists');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'ClassificationPolicyCreated',
        aggregateType: 'CLASSIFICATION_POLICY',
        aggregateId: policyId as Uuid,
        payload: { code: input.code, scopeType: input.scopeType },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'ranking.classification-policy-created',
        targetType: 'CLASSIFICATION_POLICY',
        targetId: policyId,
        details: { scopeType: input.scopeType },
      });
      await idem.record({ policyId });
      return { policyId, created: true };
    });
  }

  createClassificationPolicyVersion(input: {
    operatorAccountId: string;
    policyId: string;
    spec: unknown;
    idempotencyKey: string;
  }): Promise<{ policyVersionId: string; version: number; specHash: string; created: boolean }> {
    if (!UUID.test(input.policyId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'policy not found'));
    return this.tx(async (ctx) => {
      const v = await validatePolicyInContext(ctx, input.spec);
      const idem = await identityIdempotency<{
        policyVersionId: string;
        version: number;
        specHash: string;
      }>(ctx, {
        command: 'CreateClassificationPolicyVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { policyId: input.policyId, specHash: v.specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `classification-policy:${input.policyId}`);
      const { rows: p } = await sql<{ scope_type: string }>`
        SELECT scope_type FROM ranking.classification_policy WHERE id = ${input.policyId}`.execute(
        ctx.trx,
      );
      if (p[0] === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy not found');
      if (p[0].scope_type !== v.spec.scopeType)
        throw rejected('classification policy spec', [
          { path: '/scopeType', code: 'RESULT_SCOPE_MISMATCH' },
        ]);
      const { rows: prev } = await sql<{ version: number; spec_hash: string }>`
        SELECT version, spec_hash FROM ranking.classification_policy_version WHERE policy_id = ${input.policyId}
        ORDER BY version DESC`.execute(ctx.trx);
      if (prev.some((r) => r.spec_hash === v.specHash))
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this policy already has a version with the same spec',
        );
      const version = (prev[0]?.version ?? 0) + 1;
      const policyVersionId = newId();
      await sql`INSERT INTO ranking.classification_policy_version (id, policy_id, version, spec, spec_schema, spec_hash,
          target_engine, scope_type, discipline_version_id, primary_comparator, minimum_input_status,
          created_by_account_id, recorded_at)
        VALUES (${policyVersionId}, ${input.policyId}, ${version}, ${JSON.stringify(v.spec)}, 'br:classification-policy@1',
          ${v.specHash}, ${v.spec.targetEngine}, ${v.spec.scopeType}, ${v.spec.disciplineVersionId}, ${v.spec.primary},
          ${v.spec.minimumInputStatus}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'ClassificationPolicyVersionCreated',
        aggregateType: 'CLASSIFICATION_POLICY_VERSION',
        aggregateId: policyVersionId as Uuid,
        payload: { policyId: input.policyId, version, specHash: v.specHash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'ranking.classification-policy-version-created',
        targetType: 'CLASSIFICATION_POLICY_VERSION',
        targetId: policyVersionId,
        details: { version },
      });
      const out = { policyVersionId, version, specHash: v.specHash };
      await idem.record(out);
      return { ...out, created: true };
    });
  }

  /** DRAFT → PUBLISHED (once, re-validated against the stored hash) / PUBLISHED → RETIRED. */
  changeClassificationPolicyVersionStatus(input: {
    operatorAccountId: string;
    policyVersionId: string;
    status: 'PUBLISHED' | 'RETIRED';
  }): Promise<{ policyVersionId: string; status: string; changed: boolean }> {
    if (!UUID.test(input.policyVersionId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'policy version not found'));
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `classification-policy-version:${input.policyVersionId}`);
      const { rows } = await sql<{
        status: string;
        spec: ClassificationPolicySpec;
        spec_hash: string;
        policy_id: string;
      }>`
        SELECT c.status, v.spec, v.spec_hash, v.policy_id FROM ranking.v_classification_policy_version_current c
        JOIN ranking.classification_policy_version v ON v.id = c.policy_version_id
        WHERE c.policy_version_id = ${input.policyVersionId}`.execute(ctx.trx);
      const cur = rows[0];
      if (cur === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'policy version not found');
      if (cur.status === input.status)
        return { policyVersionId: input.policyVersionId, status: cur.status, changed: false };
      if (input.status === 'PUBLISHED') {
        const v = await validatePolicyInContext(ctx, cur.spec);
        if (v.specHash !== cur.spec_hash)
          throw new DomainError(
            DomainErrorCode.RANKING_INTEGRITY_FAILURE,
            'stored policy spec does not match its hash',
            { reason: 'POLICY_HASH_MISMATCH' },
          );
      }
      try {
        await sql`INSERT INTO ranking.classification_policy_version_status_change (id, policy_version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.policyVersionId}, ${input.status}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if ((err as { code?: string }).code === 'BR161' || pgConstraint(err) !== undefined)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            `policy version cannot move from ${cur.status} to ${input.status}`,
          );
        throw err;
      }
      await emitEvent(ctx, {
        eventType:
          input.status === 'PUBLISHED'
            ? 'ClassificationPolicyVersionPublished'
            : 'ClassificationPolicyVersionRetired',
        aggregateType: 'CLASSIFICATION_POLICY_VERSION',
        aggregateId: input.policyVersionId as Uuid,
        payload: { policyId: cur.policy_id, status: input.status, specHash: cur.spec_hash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action:
          input.status === 'PUBLISHED'
            ? 'ranking.classification-policy-version-published'
            : 'ranking.classification-policy-version-retired',
        targetType: 'CLASSIFICATION_POLICY_VERSION',
        targetId: input.policyVersionId,
      });
      return { policyVersionId: input.policyVersionId, status: input.status, changed: true };
    });
  }

  // ───────────────────────────── RankingSystem ─────────────────────────────

  createRankingSystem(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    kind: string;
    idempotencyKey: string;
  }): Promise<{ systemId: string; created: boolean }> {
    try {
      if (!CODE.test(input.code))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid system code');
      if (!(RANKING_SYSTEM_KINDS as readonly string[]).includes(input.kind))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'unsupported ranking system kind');
      checkedName(input.name);
    } catch (err) {
      return Promise.reject(err);
    }
    const name = input.name.trim();
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ systemId: string }>(ctx, {
        command: 'CreateRankingSystem',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name, kind: input.kind },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `ranking-system-code:${input.code}`);
      const systemId = newId();
      try {
        await sql`INSERT INTO ranking.system (id, code, name, kind, created_by_account_id, recorded_at)
          VALUES (${systemId}, ${input.code}, ${name}, ${input.kind}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if (pgConstraint(err) !== undefined)
          throw new DomainError(DomainErrorCode.ALREADY_EXISTS, 'system code already exists');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'RankingSystemCreated',
        aggregateType: 'RANKING_SYSTEM',
        aggregateId: systemId as Uuid,
        payload: { code: input.code, kind: input.kind },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'ranking.system-created',
        targetType: 'RANKING_SYSTEM',
        targetId: systemId,
        details: { kind: input.kind },
      });
      await idem.record({ systemId });
      return { systemId, created: true };
    });
  }

  /**
   * Validates the declarative spec BEFORE any row exists: raise-only floors, kind ↔ recognition ↔
   * owner, BEST_MARK single key equal to the exact PUBLISHED DisciplineVersion order, the OFFICIAL
   * owner's currently valid anchor covering the declared recognition, real competitions, no backdating,
   * and the same universe / kind / owner as the system's previous versions.
   */
  createRankingSystemVersion(input: {
    operatorAccountId: string;
    systemId: string;
    spec: unknown;
    idempotencyKey: string;
  }): Promise<{
    systemVersionId: string;
    version: number;
    specHash: string;
    universeHash: string;
    created: boolean;
  }> {
    if (!UUID.test(input.systemId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'system not found'));
    return this.tx(async (ctx) => {
      const v = await validateSystemInContext(ctx, input.spec);
      const idem = await identityIdempotency<{
        systemVersionId: string;
        version: number;
        specHash: string;
        universeHash: string;
      }>(ctx, {
        command: 'CreateRankingSystemVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { systemId: input.systemId, specHash: v.specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      noBackdating(v.spec.effectiveFrom, ctx.txTime);
      await lockKeys(ctx, `ranking-system:${input.systemId}`);
      const { rows: sys } = await sql<{ kind: string }>`
        SELECT kind FROM ranking.system WHERE id = ${input.systemId}`.execute(ctx.trx);
      if (sys[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'system not found');
      if (sys[0].kind !== v.spec.kind)
        throw rejected('ranking system spec', [
          { path: '/kind', code: 'KIND_CHANGE_REQUIRES_NEW_SYSTEM' },
        ]);
      const { rows: prev } = await sql<{
        spec: RankingSystemSpec;
        version: number;
        spec_hash: string;
      }>`
        SELECT spec, version, spec_hash FROM ranking.system_version WHERE system_id = ${input.systemId}
        ORDER BY version DESC`.execute(ctx.trx);
      if (prev[0] !== undefined) {
        const cont = rankingSystemVersionContinues(prev[0].spec, v.spec);
        if (!cont.ok)
          throw rejected('ranking system spec', [
            { path: '/', code: cont.code ?? 'UNIVERSE_CHANGE' },
          ]);
      }
      if (prev.some((r) => r.spec_hash === v.specHash))
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this system already has a version with the same spec',
        );
      const version = (prev[0]?.version ?? 0) + 1;
      const systemVersionId = newId();
      const s = v.spec;
      await sql`INSERT INTO ranking.system_version (id, system_id, version, spec, spec_schema, spec_hash, universe_hash,
          target_engine, kind, method, discipline_version_id, metric_key, mark_metric_id, holder_type,
          minimum_verification_level, recognition_level, owner_principal_id, owner_anchor_id, effective_from,
          created_by_account_id, recorded_at)
        VALUES (${systemVersionId}, ${input.systemId}, ${version}, ${JSON.stringify(s)}, 'br:ranking-system-version@1',
          ${v.specHash}, ${v.universeHash}, ${s.targetEngine}, ${s.kind}, ${s.method}, ${s.universe.disciplineVersionId},
          ${s.universe.metric.key}, ${s.universe.metric.markMetricId}, ${s.universe.holderType},
          ${s.requirements.minimumVerificationLevel}, ${s.recognition.level}, ${s.owner?.principalId ?? null},
          ${s.owner?.anchorId ?? null}, ${s.effectiveFrom}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await refreshSystemCard(ctx, input.systemId); // class B projection, same transaction
      await emitEvent(ctx, {
        eventType: 'RankingSystemVersionCreated',
        aggregateType: 'RANKING_SYSTEM_VERSION',
        aggregateId: systemVersionId as Uuid,
        payload: {
          systemId: input.systemId,
          version,
          specHash: v.specHash,
          universeHash: v.universeHash,
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'ranking.system-version-created',
        targetType: 'RANKING_SYSTEM_VERSION',
        targetId: systemVersionId,
        details: { version, kind: s.kind },
      });
      const out = { systemVersionId, version, specHash: v.specHash, universeHash: v.universeHash };
      await idem.record(out);
      return { ...out, created: true };
    });
  }

  /**
   * DRAFT → PUBLISHED (once; re-validated against the stored hash, the DisciplineVersion and the
   * owner's CURRENT anchor; never backdated: effectiveFrom ≥ publication) / PUBLISHED → RETIRED
   * (prevents new snapshots; history untouched). A published version is never mutated.
   */
  changeRankingSystemVersionStatus(input: {
    operatorAccountId: string;
    systemVersionId: string;
    status: 'PUBLISHED' | 'RETIRED';
  }): Promise<{ systemVersionId: string; status: string; changed: boolean }> {
    if (!UUID.test(input.systemVersionId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'system version not found'));
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `ranking-system-version:${input.systemVersionId}`);
      const { rows } = await sql<{
        status: string;
        spec: RankingSystemSpec;
        spec_hash: string;
        system_id: string;
      }>`
        SELECT c.status, v.spec, v.spec_hash, v.system_id FROM ranking.v_system_version_current c
        JOIN ranking.system_version v ON v.id = c.system_version_id
        WHERE c.system_version_id = ${input.systemVersionId}`.execute(ctx.trx);
      const cur = rows[0];
      if (cur === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'system version not found');
      if (cur.status === input.status)
        return { systemVersionId: input.systemVersionId, status: cur.status, changed: false };
      if (input.status === 'PUBLISHED') {
        const v = await validateSystemInContext(ctx, cur.spec);
        if (v.specHash !== cur.spec_hash)
          throw new DomainError(
            DomainErrorCode.RANKING_INTEGRITY_FAILURE,
            'stored system spec does not match its hash',
            { reason: 'SYSTEM_HASH_MISMATCH' },
          );
        noBackdating(v.spec.effectiveFrom, ctx.txTime);
      }
      try {
        await sql`INSERT INTO ranking.system_version_status_change (id, system_version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.systemVersionId}, ${input.status}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'BR174')
          throw new DomainError(
            DomainErrorCode.BACKDATING_REJECTED,
            'a ranking system version cannot take effect before it is published',
          );
        if (code === 'BR173' || pgConstraint(err) !== undefined)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            `system version cannot move from ${cur.status} to ${input.status}`,
          );
        throw err;
      }
      await refreshSystemCard(ctx, cur.system_id); // class B projection, same transaction
      await emitEvent(ctx, {
        eventType:
          input.status === 'PUBLISHED'
            ? 'RankingSystemVersionPublished'
            : 'RankingSystemVersionRetired',
        aggregateType: 'RANKING_SYSTEM_VERSION',
        aggregateId: input.systemVersionId as Uuid,
        payload: { systemId: cur.system_id, status: input.status, specHash: cur.spec_hash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action:
          input.status === 'PUBLISHED'
            ? 'ranking.system-version-published'
            : 'ranking.system-version-retired',
        targetType: 'RANKING_SYSTEM_VERSION',
        targetId: input.systemVersionId,
      });
      return { systemVersionId: input.systemVersionId, status: input.status, changed: true };
    });
  }

  /** Records a refused INTERNAL definition mutation (non-operator, or no operator connection). */
  auditDenied(actorAccountId: string | undefined, action: string): Promise<void> {
    return this.tx((ctx) =>
      recordAudit(ctx, {
        ...(actorAccountId === undefined ? {} : { actorAccountId }),
        action,
        targetType: 'RANKING_SYSTEM',
        outcome: 'DENIED',
      }),
    );
  }
}
