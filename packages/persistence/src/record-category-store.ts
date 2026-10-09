import {
  validateRecordCategorySpec,
  versionContinues,
  type CategoryDisciplineContext,
  type RecordCategorySpec,
} from '@br/records';
import type { DisciplineVersionSpec } from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  newId,
  RECORD_CATEGORY_SCOPE_TYPES,
  type Uuid,
} from '@br/domain';
import { sql } from 'kysely';
import type { Db } from './db';
import { identityIdempotency, lockKeys, pgConstraint, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { refreshCategoryCard } from './record-projection';
import { inTransaction, ModuleRole, type TxContext } from './tx';

const CATEGORY_CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Loads the exact DisciplineVersion a category compares (catalog data, status, sport / discipline). */
async function disciplineContext(
  ctx: TxContext,
  disciplineVersionId: string,
): Promise<CategoryDisciplineContext | undefined> {
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
    status: (r.status ?? 'DRAFT') as CategoryDisciplineContext['status'],
    sport: r.sport,
    discipline: r.discipline,
    spec: r.spec,
  };
}

const rejected = (issues: readonly { path: string; code: string }[]) =>
  new DomainError(DomainErrorCode.INVALID_INPUT, 'record category spec rejected', { issues });

/**
 * INTERNAL RecordCategory administration on the DEDICATED operator connection
 * (br_record_operator_app → br_record_rules only). Creates category identities, immutable
 * declarative versions (validated — BRT-01 floors, scope ↔ recognition coherence, model-enforced
 * naming, metric / sport / holder references against the exact PUBLISHED DisciplineVersion, one
 * comparison universe per category — before any row exists), publishes (never backdated) and retires
 * versions. It cannot evaluate, ratify, pick a holder, set a current record, force RATIFIED /
 * CANONICAL, override a comparator or touch any sporting fact: the role has no such privilege and
 * there is no such method.
 */
export class RecordCategoryStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.recordRules, fn);
  }

  createCategory(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    scopeType: string;
    idempotencyKey: string;
  }): Promise<{ categoryId: string; created: boolean }> {
    if (!CATEGORY_CODE.test(input.code))
      return Promise.reject(
        new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid category code'),
      );
    if (!(RECORD_CATEGORY_SCOPE_TYPES as readonly string[]).includes(input.scopeType))
      return Promise.reject(
        new DomainError(
          DomainErrorCode.INVALID_INPUT,
          input.scopeType === 'PERSONAL'
            ? 'PERSONAL records are the PERSONAL_BEST Achievement (no PERSONAL category in BRT-09)'
            : 'unsupported record scope',
        ),
      );
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120)
      return Promise.reject(
        new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid category name'),
      );
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ categoryId: string }>(ctx, {
        command: 'CreateRecordCategory',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name, scopeType: input.scopeType },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `record-category-code:${input.code}`);
      const categoryId = newId();
      try {
        await sql`INSERT INTO record.category (id, code, name, scope_type, created_by_account_id, recorded_at)
          VALUES (${categoryId}, ${input.code}, ${name}, ${input.scopeType}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if (pgConstraint(err) !== undefined)
          throw new DomainError(DomainErrorCode.ALREADY_EXISTS, 'category code already exists');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'RecordCategoryCreated',
        aggregateType: 'RECORD_CATEGORY',
        aggregateId: categoryId as Uuid,
        payload: { code: input.code, scopeType: input.scopeType },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'record.category-created',
        targetType: 'RECORD_CATEGORY',
        targetId: categoryId,
        details: { scopeType: input.scopeType },
      });
      await idem.record({ categoryId });
      return { categoryId, created: true };
    });
  }

  /** Validates the declarative spec against its exact DisciplineVersion BEFORE any row exists. */
  createCategoryVersion(input: {
    operatorAccountId: string;
    categoryId: string;
    spec: unknown;
    idempotencyKey: string;
  }): Promise<{ categoryVersionId: string; version: number; specHash: string; created: boolean }> {
    const structural = validateRecordCategorySpec(input.spec);
    if (!structural.ok) return Promise.reject(rejected(structural.issues));
    return this.tx(async (ctx) => {
      const dv = await disciplineContext(ctx, structural.spec.universe.disciplineVersionId);
      if (dv === undefined)
        throw rejected([
          { path: '/universe/disciplineVersionId', code: 'DISCIPLINE_VERSION_UNKNOWN' },
        ]);
      const v = validateRecordCategorySpec(input.spec, dv);
      if (!v.ok) throw rejected(v.issues);
      const idem = await identityIdempotency<{
        categoryVersionId: string;
        version: number;
        specHash: string;
      }>(ctx, {
        command: 'CreateRecordCategoryVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { categoryId: input.categoryId, specHash: v.specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (!UUID.test(input.categoryId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'category not found');
      await lockKeys(ctx, `record-category:${input.categoryId}`);
      const { rows: c } = await sql<{ scope_type: string }>`
        SELECT scope_type FROM record.category WHERE id = ${input.categoryId}`.execute(ctx.trx);
      if (c[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'category not found');
      if (c[0].scope_type !== v.spec.scope.scopeType)
        throw rejected([{ path: '/scope/scopeType', code: 'CATEGORY_SCOPE_MISMATCH' }]);
      // A COMPETITION series names real competitions only.
      for (const competitionId of v.spec.scope.competitionIds ?? []) {
        const { rows } = await sql<{ id: string }>`
          SELECT id FROM competition.competition WHERE id = ${competitionId}`.execute(ctx.trx);
        if (rows[0] === undefined)
          throw rejected([{ path: '/scope/competitionIds', code: 'COMPETITION_UNKNOWN' }]);
      }
      const { rows: prev } = await sql<{ spec: RecordCategorySpec; version: number }>`
        SELECT spec, version FROM record.category_version WHERE category_id = ${input.categoryId}
        ORDER BY version DESC LIMIT 1`.execute(ctx.trx);
      if (prev[0] !== undefined) {
        const cont = versionContinues(prev[0].spec, v.spec);
        if (!cont.ok) throw rejected([{ path: '/', code: cont.code ?? 'UNIVERSE_CHANGE' }]);
      }
      const { rows: same } = await sql<{ id: string }>`
        SELECT id FROM record.category_version WHERE category_id = ${input.categoryId} AND spec_hash = ${v.specHash}`.execute(
        ctx.trx,
      );
      if (same[0] !== undefined)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this category already has a version with the same spec',
        );
      const version = (prev[0]?.version ?? 0) + 1;
      const categoryVersionId = newId();
      await sql`INSERT INTO record.category_version
          (id, category_id, version, spec, spec_schema, spec_hash, universe_hash, target_engine, scope_type,
           discipline_version_id, metric_key, mark_metric_id, effective_from, created_by_account_id, recorded_at)
        VALUES (${categoryVersionId}, ${input.categoryId}, ${version}, ${JSON.stringify(v.spec)},
                'br:record-category-version@1', ${v.specHash}, ${v.universeHash}, ${v.spec.targetEngine},
                ${v.spec.scope.scopeType}, ${v.spec.universe.disciplineVersionId}, ${v.spec.universe.metric.key},
                ${v.spec.universe.metric.markMetricId}, ${v.spec.effectiveFrom}, ${input.operatorAccountId},
                ${ctx.txTime})`.execute(ctx.trx);
      await emitEvent(ctx, {
        eventType: 'RecordCategoryVersionCreated',
        aggregateType: 'RECORD_CATEGORY_VERSION',
        aggregateId: categoryVersionId as Uuid,
        payload: { categoryId: input.categoryId, version, specHash: v.specHash },
      });
      await refreshCategoryCard(ctx, input.categoryId);
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'record.category-version-created',
        targetType: 'RECORD_CATEGORY_VERSION',
        targetId: categoryVersionId,
        details: { version },
      });
      const out = { categoryVersionId, version, specHash: v.specHash };
      await idem.record(out);
      return { ...out, created: true };
    });
  }

  /**
   * DRAFT → PUBLISHED (once, re-validated, never backdated: effectiveFrom ≥ publication) /
   * PUBLISHED → RETIRED (prevents NEW evaluation; historical marks are untouched).
   */
  changeVersionStatus(input: {
    operatorAccountId: string;
    categoryVersionId: string;
    status: 'PUBLISHED' | 'RETIRED';
  }): Promise<{ categoryVersionId: string; status: string; changed: boolean }> {
    if (!UUID.test(input.categoryVersionId))
      return Promise.reject(
        new DomainError(DomainErrorCode.NOT_FOUND, 'category version not found'),
      );
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `record-category-version:${input.categoryVersionId}`);
      const { rows } = await sql<{
        status: string;
        spec: RecordCategorySpec;
        spec_hash: string;
        category_id: string;
      }>`
        SELECT c.status, v.spec, v.spec_hash, v.category_id FROM record.v_category_version_current c
        JOIN record.category_version v ON v.id = c.category_version_id
        WHERE c.category_version_id = ${input.categoryVersionId}`.execute(ctx.trx);
      const cur = rows[0];
      if (cur === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'category version not found');
      if (cur.status === input.status)
        return { categoryVersionId: input.categoryVersionId, status: cur.status, changed: false };
      if (input.status === 'PUBLISHED') {
        const dv = await disciplineContext(ctx, cur.spec.universe.disciplineVersionId);
        const v = validateRecordCategorySpec(cur.spec, dv);
        if (dv === undefined || !v.ok)
          throw rejected(
            v.ok
              ? [{ path: '/universe/disciplineVersionId', code: 'DISCIPLINE_VERSION_UNKNOWN' }]
              : v.issues,
          );
        if (v.specHash !== cur.spec_hash)
          throw new DomainError(
            DomainErrorCode.RECORD_INTEGRITY_FAILURE,
            'stored category spec does not match its hash',
            { reason: 'CATEGORY_HASH_MISMATCH' },
          );
        if (Date.parse(cur.spec.effectiveFrom) < ctx.txTime.getTime())
          throw new DomainError(
            DomainErrorCode.BACKDATING_REJECTED,
            'a category version cannot take effect before it is published',
          );
      }
      try {
        await sql`INSERT INTO record.category_version_status_change (id, category_version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.categoryVersionId}, ${input.status}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'BR142')
          throw new DomainError(
            DomainErrorCode.BACKDATING_REJECTED,
            'a category version cannot take effect before it is published',
          );
        if (code === 'BR143' || pgConstraint(err) !== undefined)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            `category version cannot move from ${cur.status} to ${input.status}`,
          );
        throw err;
      }
      await emitEvent(ctx, {
        eventType:
          input.status === 'PUBLISHED'
            ? 'RecordCategoryVersionPublished'
            : 'RecordCategoryVersionRetired',
        aggregateType: 'RECORD_CATEGORY_VERSION',
        aggregateId: input.categoryVersionId as Uuid,
        payload: { categoryId: cur.category_id, status: input.status, specHash: cur.spec_hash },
      });
      await refreshCategoryCard(ctx, cur.category_id);
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action:
          input.status === 'PUBLISHED'
            ? 'record.category-version-published'
            : 'record.category-version-retired',
        targetType: 'RECORD_CATEGORY_VERSION',
        targetId: input.categoryVersionId,
      });
      return { categoryVersionId: input.categoryVersionId, status: input.status, changed: true };
    });
  }

  /** Records a refused INTERNAL category mutation (non-operator, or no operator connection). */
  auditDenied(actorAccountId: string | undefined, action: string): Promise<void> {
    return this.tx((ctx) =>
      recordAudit(ctx, {
        ...(actorAccountId === undefined ? {} : { actorAccountId }),
        action,
        targetType: 'RECORD_CATEGORY',
        outcome: 'DENIED',
      }),
    );
  }
}
