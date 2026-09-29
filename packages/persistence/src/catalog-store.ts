import {
  canTransition,
  CatalogVersionLifecycle,
  catalogSpecHash,
  DISCIPLINE_CODE,
  disciplineBelongsToSport,
  FORMAT_CODE,
  formatEngine,
  SPORT_CODE,
  validateDisciplineVersionSpec,
  type CatalogVersionStatus,
  type DisciplineVersionSpec,
} from '@br/competition';
import { DomainError, DomainErrorCode, newId, type Uuid } from '@br/domain';
import { sql } from 'kysely';
import { text, transitionError } from './competition-support';
import type { Db } from './db';
import { identityIdempotency, lockKeys, pgConstraint, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * Sport catalog (br_catalog). INTERNAL/operator-only: organizers never define or edit sports,
 * disciplines, rules or formats — they pin PUBLISHED versions. Versions are immutable from
 * creation; publishing/retiring is an append-only status fact.
 */
export class CatalogStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.catalog, fn);
  }

  private async unique<T>(fn: () => Promise<T>, what: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgConstraint(err) !== undefined)
        throw new DomainError(DomainErrorCode.ALREADY_EXISTS, `${what} already exists`);
      throw err;
    }
  }

  createSport(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ sportId: string; created: boolean }> {
    if (!SPORT_CODE.test(input.code) || input.code.length > 64)
      return Promise.reject(new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid sport code'));
    const name = text(input.name, 80, 'name');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ sportId: string }>(ctx, {
        command: 'CreateSport',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `sport-code:${input.code}`);
      const sportId = newId();
      await this.unique(
        () =>
          sql`INSERT INTO sports.sport (id, code, name, created_by_account_id, recorded_at)
          VALUES (${sportId}, ${input.code}, ${name}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
            ctx.trx,
          ),
        'sport code',
      );
      await emitEvent(ctx, {
        eventType: 'SportCreated',
        aggregateType: 'SPORT',
        aggregateId: sportId as Uuid,
        payload: { code: input.code },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'catalog.sport-created',
        targetType: 'SPORT',
        targetId: sportId,
      });
      await idem.record({ sportId });
      return { sportId, created: true };
    });
  }

  createDiscipline(input: {
    operatorAccountId: string;
    sportId: string;
    code: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ disciplineId: string; created: boolean }> {
    if (!DISCIPLINE_CODE.test(input.code) || input.code.length > 128)
      return Promise.reject(
        new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid discipline code'),
      );
    const name = text(input.name, 80, 'name');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ disciplineId: string }>(ctx, {
        command: 'CreateDiscipline',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { sportId: input.sportId, code: input.code, name },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      const { rows } = await sql<{
        code: string;
      }>`SELECT code FROM sports.sport WHERE id = ${input.sportId}`.execute(ctx.trx);
      if (rows[0] === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'sport not found');
      if (!disciplineBelongsToSport(input.code, rows[0].code)) {
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `discipline code must be in the "${rows[0].code}." namespace`,
        );
      }
      await lockKeys(ctx, `discipline-code:${input.code}`);
      const disciplineId = newId();
      await this.unique(
        () =>
          sql`INSERT INTO sports.discipline (id, sport_id, code, name, created_by_account_id, recorded_at)
          VALUES (${disciplineId}, ${input.sportId}, ${input.code}, ${name}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
            ctx.trx,
          ),
        'discipline code',
      );
      await emitEvent(ctx, {
        eventType: 'DisciplineCreated',
        aggregateType: 'DISCIPLINE',
        aggregateId: disciplineId as Uuid,
        payload: { code: input.code },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'catalog.discipline-created',
        targetType: 'DISCIPLINE',
        targetId: disciplineId,
      });
      await idem.record({ disciplineId });
      return { disciplineId, created: true };
    });
  }

  /** New DRAFT version with the next version number. The spec is validated and then immutable. */
  createDisciplineVersion(input: {
    operatorAccountId: string;
    disciplineId: string;
    spec: DisciplineVersionSpec;
    idempotencyKey: string;
  }): Promise<{
    disciplineVersionId: string;
    version: number;
    specHash: string;
    created: boolean;
  }> {
    const issues = validateDisciplineVersionSpec(input.spec);
    if (issues.length > 0) {
      return Promise.reject(
        new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid discipline version specification', {
          issues: issues.slice(0, 20),
        }),
      );
    }
    const specHash = catalogSpecHash('br:discipline-version-spec', input.spec);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        disciplineVersionId: string;
        version: number;
        specHash: string;
      }>(ctx, {
        command: 'CreateDisciplineVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { disciplineId: input.disciplineId, specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `discipline-versions:${input.disciplineId}`);
      const { rows } = await sql<{ n: number | null; exists: boolean }>`
        SELECT (SELECT max(version) FROM sports.discipline_version WHERE discipline_id = ${input.disciplineId}) AS n,
               EXISTS (SELECT 1 FROM sports.discipline WHERE id = ${input.disciplineId}) AS exists`.execute(
        ctx.trx,
      );
      if (rows[0]?.exists !== true)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'discipline not found');
      const version = (rows[0]?.n ?? 0) + 1;
      const id = newId();
      await sql`INSERT INTO sports.discipline_version (id, discipline_id, version, spec, spec_hash, created_by_account_id, recorded_at)
        VALUES (${id}, ${input.disciplineId}, ${version}, ${JSON.stringify(input.spec)}::jsonb, ${specHash}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await sql`INSERT INTO sports.discipline_version_status_change (id, discipline_version_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, 'DRAFT', ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'DisciplineVersionCreated',
        aggregateType: 'DISCIPLINE_VERSION',
        aggregateId: id as Uuid,
        payload: { disciplineId: input.disciplineId, version, specHash },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'catalog.discipline-version-created',
        targetType: 'DISCIPLINE_VERSION',
        targetId: id,
      });
      const response = { disciplineVersionId: id, version, specHash };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  publishDisciplineVersion(input: {
    operatorAccountId: string;
    disciplineVersionId: string;
  }): Promise<void> {
    return this.setVersionStatus(
      'discipline',
      input.disciplineVersionId,
      'PUBLISHED',
      input.operatorAccountId,
    );
  }

  retireDisciplineVersion(input: {
    operatorAccountId: string;
    disciplineVersionId: string;
  }): Promise<void> {
    return this.setVersionStatus(
      'discipline',
      input.disciplineVersionId,
      'RETIRED',
      input.operatorAccountId,
    );
  }

  createFormatTemplate(input: {
    operatorAccountId: string;
    code: string;
    name: string;
    idempotencyKey: string;
  }): Promise<{ formatTemplateId: string; created: boolean }> {
    if (!FORMAT_CODE.test(input.code) || input.code.length > 64)
      return Promise.reject(new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid format code'));
    const name = text(input.name, 80, 'name');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ formatTemplateId: string }>(ctx, {
        command: 'CreateFormatTemplate',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { code: input.code, name },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `format-code:${input.code}`);
      const id = newId();
      await this.unique(
        () =>
          sql`INSERT INTO sports.format_template (id, code, name, created_by_account_id, recorded_at)
          VALUES (${id}, ${input.code}, ${name}, ${input.operatorAccountId}, ${ctx.txTime})`.execute(
            ctx.trx,
          ),
        'format code',
      );
      await emitEvent(ctx, {
        eventType: 'FormatTemplateCreated',
        aggregateType: 'FORMAT_TEMPLATE',
        aggregateId: id as Uuid,
        payload: { code: input.code },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'catalog.format-template-created',
        targetType: 'FORMAT_TEMPLATE',
        targetId: id,
      });
      await idem.record({ formatTemplateId: id });
      return { formatTemplateId: id, created: true };
    });
  }

  /** New DRAFT FormatVersion pinning an exact registered engine version and its config schema. */
  createFormatVersion(input: {
    operatorAccountId: string;
    formatTemplateId: string;
    engineId: string;
    engineVersion: number;
    idempotencyKey: string;
  }): Promise<{ formatVersionId: string; version: number; specHash: string; created: boolean }> {
    const engine = formatEngine(input.engineId, input.engineVersion);
    if (engine === undefined) {
      return Promise.reject(
        new DomainError(
          DomainErrorCode.INVALID_INPUT,
          `no registered format engine ${input.engineId}/${input.engineVersion}`,
        ),
      );
    }
    const spec = {
      engineId: engine.id,
      engineVersion: engine.version,
      configurationSchema: engine.configurationSchema,
      contestType: engine.contestType,
    };
    const specHash = catalogSpecHash('br:format-version-spec', spec);
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{
        formatVersionId: string;
        version: number;
        specHash: string;
      }>(ctx, {
        command: 'CreateFormatVersion',
        actorAccountId: input.operatorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: { formatTemplateId: input.formatTemplateId, specHash },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `format-versions:${input.formatTemplateId}`);
      const { rows } = await sql<{ n: number | null; exists: boolean }>`
        SELECT (SELECT max(version) FROM sports.format_version WHERE template_id = ${input.formatTemplateId}) AS n,
               EXISTS (SELECT 1 FROM sports.format_template WHERE id = ${input.formatTemplateId}) AS exists`.execute(
        ctx.trx,
      );
      if (rows[0]?.exists !== true)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'format template not found');
      const version = (rows[0]?.n ?? 0) + 1;
      const id = newId();
      await sql`INSERT INTO sports.format_version (id, template_id, version, engine_id, engine_version, configuration_schema, spec_hash, created_by_account_id, recorded_at)
        VALUES (${id}, ${input.formatTemplateId}, ${version}, ${engine.id}, ${engine.version}, ${JSON.stringify(engine.configurationSchema)}::jsonb, ${specHash},
                ${input.operatorAccountId}, ${ctx.txTime})`.execute(ctx.trx);
      await sql`INSERT INTO sports.format_version_status_change (id, format_version_id, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, 'DRAFT', ${input.operatorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'FormatVersionCreated',
        aggregateType: 'FORMAT_VERSION',
        aggregateId: id as Uuid,
        payload: {
          formatTemplateId: input.formatTemplateId,
          version,
          engine: `${engine.id}/${engine.version}`,
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.operatorAccountId,
        action: 'catalog.format-version-created',
        targetType: 'FORMAT_VERSION',
        targetId: id,
      });
      const response = { formatVersionId: id, version, specHash };
      await idem.record(response);
      return { ...response, created: true };
    });
  }

  publishFormatVersion(input: {
    operatorAccountId: string;
    formatVersionId: string;
  }): Promise<void> {
    return this.setVersionStatus(
      'format',
      input.formatVersionId,
      'PUBLISHED',
      input.operatorAccountId,
    );
  }

  retireFormatVersion(input: {
    operatorAccountId: string;
    formatVersionId: string;
  }): Promise<void> {
    return this.setVersionStatus(
      'format',
      input.formatVersionId,
      'RETIRED',
      input.operatorAccountId,
    );
  }

  private setVersionStatus(
    kind: 'discipline' | 'format',
    id: string,
    to: CatalogVersionStatus,
    actor: string,
  ): Promise<void> {
    const t =
      kind === 'discipline'
        ? {
            status: 'sports.discipline_version_status_change',
            col: 'discipline_version_id',
            view: 'sports.v_discipline_version_current',
            agg: 'DISCIPLINE_VERSION' as const,
            ev:
              to === 'PUBLISHED'
                ? ('DisciplineVersionPublished' as const)
                : ('DisciplineVersionRetired' as const),
          }
        : {
            status: 'sports.format_version_status_change',
            col: 'format_version_id',
            view: 'sports.v_format_version_current',
            agg: 'FORMAT_VERSION' as const,
            ev:
              to === 'PUBLISHED'
                ? ('FormatVersionPublished' as const)
                : ('FormatVersionRetired' as const),
          };
    return this.tx(async (ctx) => {
      await lockKeys(ctx, `catalog-version:${id}`);
      const { rows } = await sql<{
        status: CatalogVersionStatus;
      }>`SELECT status FROM ${sql.raw(t.view)} WHERE ${sql.ref(t.col)} = ${id}`.execute(ctx.trx);
      const from = rows[0]?.status;
      if (from === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, `${kind} version not found`);
      if (!canTransition(CatalogVersionLifecycle, from, to))
        throw transitionError(`${kind} version`, from, to);
      await sql`INSERT INTO ${sql.raw(t.status)} (id, ${sql.ref(t.col)}, status, actor_account_id, recorded_at)
        VALUES (${newId()}, ${id}, ${to}, ${actor}, ${ctx.txTime})`.execute(ctx.trx);
      await emitEvent(ctx, {
        eventType: t.ev,
        aggregateType: t.agg,
        aggregateId: id as Uuid,
        payload: { status: to },
      });
      await recordAudit(ctx, {
        actorAccountId: actor,
        action: `catalog.${kind}-version-${to.toLowerCase()}`,
        targetType: t.agg,
        targetId: id,
      });
    });
  }
}
