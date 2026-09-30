import {
  validateAchievementRuleSpec,
  type AchievementRuleSpec,
  type RuleDisciplineContext,
} from '@br/achievements';
import type { DisciplineVersionSpec } from '@br/competition';
import { ACHIEVEMENT_TYPES, DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import type { Db } from './db';
import { identityIdempotency, lockKeys, pgConstraint, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

const RULE_CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Loads the exact DisciplineVersion a rule references (catalog data + lifecycle status). */
async function disciplineContext(
  ctx: TxContext,
  disciplineVersionId: string,
): Promise<RuleDisciplineContext | undefined> {
  if (!UUID.test(disciplineVersionId)) return undefined;
  const { rows } = await sql<{ spec: DisciplineVersionSpec; status: string | null }>`
    SELECT v.spec, c.status FROM sports.discipline_version v
    LEFT JOIN sports.v_discipline_version_current c ON c.discipline_version_id = v.id
    WHERE v.id = ${disciplineVersionId}`.execute(ctx.trx);
  const r = rows[0];
  if (r === undefined) return undefined;
  return {
    disciplineVersionId,
    status: (r.status ?? 'DRAFT') as RuleDisciplineContext['status'],
    spec: r.spec,
  };
}

const rejected = (issues: readonly { path: string; code: string }[]) =>
  new DomainError(DomainErrorCode.INVALID_INPUT, 'achievement rule spec rejected', { issues });

/**
 * INTERNAL AchievementRule administration on the DEDICATED operator connection
 * (br_achievement_operator_app → br_achievement_rules only). Creates rule identities, immutable
 * declarative versions (validated — including BRT-01 platform floors and metric references against
 * the exact PUBLISHED DisciplineVersion — before any row exists), publishes / retires versions and
 * binds PUBLISHED versions. It cannot derive, award, choose a holder or touch any sporting fact: the
 * role has no such privilege and there is no such method.
 */
export class AchievementRuleStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.achievementRules, fn);
  }

  createRule(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    achievementType: string;
    idempotencyKey: string;
  }): Promise<{ ruleId: string; created: boolean }> {
    if (!RULE_CODE.test(input.code))
      return Promise.reject(new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid rule code'));
    if (!(ACHIEVEMENT_TYPES as readonly string[]).includes(input.achievementType))
      return Promise.reject(
        new DomainError(DomainErrorCode.INVALID_INPUT, 'unsupported achievement type'),
      );
    const name = input.name.trim();
    if (name.length === 0 || name.length > 120)
      return Promise.reject(new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid rule name'));
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ ruleId: string }>(ctx, {
        command: 'CreateAchievementRule',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name, achievementType: input.achievementType },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `achievement-rule-code:${input.code}`);
      const ruleId = newId();
      try {
        await sql`INSERT INTO achievement.rule (id, code, name, achievement_type, created_by_account_id, recorded_at)
          VALUES (${ruleId}, ${input.code}, ${name}, ${input.achievementType}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if (pgConstraint(err) !== undefined)
          throw new DomainError(DomainErrorCode.ALREADY_EXISTS, 'rule code already exists');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'AchievementRuleCreated',
        aggregateType: 'ACHIEVEMENT_RULE',
        aggregateId: ruleId as Uuid,
        payload: { code: input.code, achievementType: input.achievementType },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'achievement.rule-created',
        targetType: 'ACHIEVEMENT_RULE',
        targetId: ruleId,
        details: { achievementType: input.achievementType },
      });
      await idem.record({ ruleId });
      return { ruleId, created: true };
    });
  }

  /** Validates the declarative spec against its exact DisciplineVersion BEFORE any row exists. */
  createRuleVersion(input: {
    operatorAccountId: string;
    ruleId: string;
    spec: unknown;
    idempotencyKey: string;
  }): Promise<{ ruleVersionId: string; version: number; specHash: string; created: boolean }> {
    const structural = validateAchievementRuleSpec(input.spec);
    if (!structural.ok) return Promise.reject(rejected(structural.issues));
    return this.tx(async (ctx) => {
      const dv = await disciplineContext(ctx, structural.spec.disciplineVersionId);
      if (dv === undefined)
        throw rejected([{ path: '/disciplineVersionId', code: 'DISCIPLINE_VERSION_UNKNOWN' }]);
      const v = validateAchievementRuleSpec(input.spec, dv);
      if (!v.ok) throw rejected(v.issues);
      const idem = await identityIdempotency<{
        ruleVersionId: string;
        version: number;
        specHash: string;
      }>(ctx, {
        command: 'CreateAchievementRuleVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { ruleId: input.ruleId, specHash: v.specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      if (!UUID.test(input.ruleId))
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'rule not found');
      await lockKeys(ctx, `achievement-rule:${input.ruleId}`);
      const { rows: r } = await sql<{ achievement_type: string }>`
        SELECT achievement_type FROM achievement.rule WHERE id = ${input.ruleId}`.execute(ctx.trx);
      if (r[0] === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'rule not found');
      if (r[0].achievement_type !== v.spec.achievementType)
        throw rejected([{ path: '/achievementType', code: 'RULE_TYPE_MISMATCH' }]);
      const { rows: same } = await sql<{ id: string }>`
        SELECT id FROM achievement.rule_version WHERE rule_id = ${input.ruleId} AND spec_hash = ${v.specHash}`.execute(
        ctx.trx,
      );
      if (same[0] !== undefined)
        throw new DomainError(
          DomainErrorCode.ALREADY_EXISTS,
          'this rule already has a version with the same spec',
        );
      const { rows: max } = await sql<{ n: number | null }>`
        SELECT max(version) AS n FROM achievement.rule_version WHERE rule_id = ${input.ruleId}`.execute(
        ctx.trx,
      );
      const version = (max[0]?.n ?? 0) + 1;
      const ruleVersionId = newId();
      await sql`INSERT INTO achievement.rule_version
          (id, rule_id, version, spec, spec_schema, spec_hash, target_engine, achievement_type, discipline_version_id,
           created_by_account_id, recorded_at)
        VALUES (${ruleVersionId}, ${input.ruleId}, ${version}, ${JSON.stringify(v.spec)}, 'br:achievement-rule@1',
                ${v.specHash}, ${v.spec.targetEngine}, ${v.spec.achievementType}, ${v.spec.disciplineVersionId},
                ${input.operatorAccountId}, ${ctx.txTime})`.execute(ctx.trx);
      await emitEvent(ctx, {
        eventType: 'AchievementRuleVersionCreated',
        aggregateType: 'ACHIEVEMENT_RULE_VERSION',
        aggregateId: ruleVersionId as Uuid,
        payload: { ruleId: input.ruleId, version, specHash: v.specHash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'achievement.rule-version-created',
        targetType: 'ACHIEVEMENT_RULE_VERSION',
        targetId: ruleVersionId,
        details: { version },
      });
      const out = { ruleVersionId, version, specHash: v.specHash };
      await idem.record(out);
      return { ...out, created: true };
    });
  }

  /** DRAFT → PUBLISHED (once, re-validated) / PUBLISHED → RETIRED. Published versions stay immutable. */
  changeVersionStatus(input: {
    operatorAccountId: string;
    ruleVersionId: string;
    status: 'PUBLISHED' | 'RETIRED';
  }): Promise<{ ruleVersionId: string; status: string; changed: boolean }> {
    if (!UUID.test(input.ruleVersionId))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'rule version not found'));
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `achievement-rule-version:${input.ruleVersionId}`);
      const { rows } = await sql<{ status: string; spec: AchievementRuleSpec; spec_hash: string }>`
        SELECT c.status, v.spec, v.spec_hash FROM achievement.v_rule_version_current c
        JOIN achievement.rule_version v ON v.id = c.rule_version_id
        WHERE c.rule_version_id = ${input.ruleVersionId}`.execute(ctx.trx);
      const cur = rows[0];
      if (cur === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'rule version not found');
      if (cur.status === input.status)
        return { ruleVersionId: input.ruleVersionId, status: cur.status, changed: false };
      if (input.status === 'PUBLISHED') {
        // Re-validate the stored spec (floors, metrics, PUBLISHED DisciplineVersion) before it can
        // drive any derivation — defence in depth against tampering and catalog changes.
        const dv = await disciplineContext(ctx, cur.spec.disciplineVersionId);
        const v = validateAchievementRuleSpec(cur.spec, dv);
        if (dv === undefined || !v.ok)
          throw rejected(
            v.ok
              ? [{ path: '/disciplineVersionId', code: 'DISCIPLINE_VERSION_UNKNOWN' }]
              : v.issues,
          );
        if (v.specHash !== cur.spec_hash)
          throw new DomainError(
            DomainErrorCode.ACHIEVEMENT_INTEGRITY_FAILURE,
            'stored rule spec does not match its hash',
            { reason: 'RULE_HASH_MISMATCH' },
          );
      }
      try {
        await sql`INSERT INTO achievement.rule_version_status_change (id, rule_version_id, status, actor_account_id, recorded_at)
          VALUES (${newId()}, ${input.ruleVersionId}, ${input.status}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        if ((err as { code?: string }).code === 'BR111' || pgConstraint(err) !== undefined)
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            `rule version cannot move from ${cur.status} to ${input.status}`,
          );
        throw err;
      }
      await emitEvent(ctx, {
        eventType:
          input.status === 'PUBLISHED'
            ? 'AchievementRuleVersionPublished'
            : 'AchievementRuleVersionRetired',
        aggregateType: 'ACHIEVEMENT_RULE_VERSION',
        aggregateId: input.ruleVersionId as Uuid,
        payload: { status: input.status, specHash: cur.spec_hash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action:
          input.status === 'PUBLISHED'
            ? 'achievement.rule-version-published'
            : 'achievement.rule-version-retired',
        targetType: 'ACHIEVEMENT_RULE_VERSION',
        targetId: input.ruleVersionId,
      });
      return { ruleVersionId: input.ruleVersionId, status: input.status, changed: true };
    });
  }

  /**
   * Appends a binding of a PUBLISHED version to its exact DisciplineVersion (optionally narrowed to
   * one Competition / Event), effective now or later — never earlier than its recording time. The
   * binding governs ResultVersions submitted while it is in force; it never re-derives the past.
   */
  bindRule(input: {
    operatorAccountId: string;
    ruleVersionId: string;
    competitionId?: string;
    eventId?: string;
    effectiveFrom?: Date;
    idempotencyKey: string;
  }): Promise<{ bindingId: string; effectiveFrom: string; created: boolean }> {
    const ids = [input.ruleVersionId, input.competitionId, input.eventId].filter(
      (x): x is string => x !== undefined,
    );
    if (ids.some((x) => !UUID.test(x)))
      return Promise.reject(new DomainError(DomainErrorCode.NOT_FOUND, 'not found'));
    if (input.eventId !== undefined && input.competitionId === undefined)
      return Promise.reject(
        new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'an event binding must name its competition',
        ),
      );
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ bindingId: string; effectiveFrom: string }>(ctx, {
        command: 'BindAchievementRule',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          ruleVersionId: input.ruleVersionId,
          competitionId: input.competitionId,
          eventId: input.eventId,
          effectiveFrom: input.effectiveFrom?.toISOString(),
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const effectiveFrom = input.effectiveFrom ?? ctx.txTime;
      if (effectiveFrom.getTime() < ctx.txTime.getTime())
        throw new DomainError(
          DomainErrorCode.BACKDATING_REJECTED,
          'a rule binding cannot take effect before it is recorded',
        );
      const { rows: v } = await sql<{ rule_id: string; discipline_version_id: string }>`
        SELECT rule_id, discipline_version_id FROM achievement.rule_version WHERE id = ${input.ruleVersionId}`.execute(
        ctx.trx,
      );
      const version = v[0];
      if (version === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'rule version not found');
      if (input.competitionId !== undefined) {
        const { rows: c } = await sql<{ id: string }>`
          SELECT id FROM competition.competition WHERE id = ${input.competitionId}`.execute(
          ctx.trx,
        );
        if (c[0] === undefined)
          throw new DomainError(DomainErrorCode.NOT_FOUND, 'competition not found');
      }
      const bindingId = newId();
      try {
        await sql`INSERT INTO achievement.rule_binding
            (id, rule_id, rule_version_id, discipline_version_id, competition_id, event_id, effective_from, actor_account_id, recorded_at)
          VALUES (${bindingId}, ${version.rule_id}, ${input.ruleVersionId}, ${version.discipline_version_id},
                  ${input.competitionId ?? null}, ${input.eventId ?? null}, ${effectiveFrom}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
          ctx.trx,
        );
      } catch (err) {
        const c = (err as { code?: string }).code;
        if (c === 'BR112')
          throw new DomainError(
            DomainErrorCode.INVALID_TRANSITION,
            'only a PUBLISHED rule version can be bound',
          );
        if (c === 'BR113')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'a binding must take effect strictly after the previous binding',
          );
        if (c === 'BR114' || c === '23503')
          throw new DomainError(DomainErrorCode.INVALID_INPUT, 'binding scope is not valid');
        throw err;
      }
      await emitEvent(ctx, {
        eventType: 'AchievementRuleBound',
        aggregateType: 'ACHIEVEMENT_RULE_VERSION',
        aggregateId: input.ruleVersionId as Uuid,
        payload: {
          bindingId,
          disciplineVersionId: version.discipline_version_id,
          ...(input.competitionId === undefined ? {} : { competitionId: input.competitionId }),
          ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
          effectiveFrom: effectiveFrom.toISOString(),
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'achievement.rule-bound',
        targetType: 'ACHIEVEMENT_RULE_VERSION',
        targetId: input.ruleVersionId,
        details: { disciplineVersionId: version.discipline_version_id },
      });
      const out = { bindingId, effectiveFrom: effectiveFrom.toISOString() };
      await idem.record(out);
      return { ...out, created: true };
    });
  }

  /** Records a refused INTERNAL rule mutation (non-operator, or no operator connection). */
  auditDenied(actorAccountId: string | undefined, action: string): Promise<void> {
    return this.tx((ctx) =>
      recordAudit(ctx, {
        ...(actorAccountId === undefined ? {} : { actorAccountId }),
        action,
        targetType: 'ACHIEVEMENT_RULE',
        outcome: 'DENIED',
      }),
    );
  }
}
