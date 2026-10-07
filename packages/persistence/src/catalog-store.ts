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
  type CatalogManifest,
  type CatalogVersionStatus,
  formatVersionSpec,
  type AnyFormatEngine,
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
 * The content hash a FormatVersion pinning `engine` carries. v1 engines keep their exact BRT-05
 * spec (unchanged hashes); v2 engines also hash their declared capability requirements.
 */
function formatVersionSpecHash(engine: AnyFormatEngine): string {
  return catalogSpecHash('br:format-version-spec', formatVersionSpec(engine));
}

export type CatalogProvisionAction =
  'UNCHANGED' | 'CREATED' | 'PUBLISHED' | 'WOULD_CREATE' | 'WOULD_PUBLISH';

export interface CatalogProvisionReport {
  readonly steps: readonly {
    readonly kind: 'sport' | 'discipline' | 'discipline-version' | 'format' | 'format-version';
    readonly code: string;
    readonly action: CatalogProvisionAction;
    readonly id?: string;
  }[];
  /** Entries the provisioner refused to touch; an operator must resolve them deliberately. */
  readonly conflicts: readonly { readonly code: string; readonly reason: string }[];
}

type VersionRow = { id: string; spec_hash: string; status: CatalogVersionStatus };

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
    const specHash = formatVersionSpecHash(engine);
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

  // ───────────────────────────── provisioning (ONCF-03A) ─────────────────────────────

  /**
   * Applies a declared catalog lookup-first: a sport, discipline or format whose code exists is
   * reused; a discipline/format version whose content hash already exists is reused (and published
   * if still DRAFT). Nothing is ever duplicated, so re-running converges. A discipline or format
   * that already has versions, none with the declared content, is a CONFLICT and left untouched:
   * versions are immutable semantics and a new one is an operator decision, never a side effect.
   * A RETIRED matching version is also a conflict (retiring is deliberate; it is not undone here).
   * `dryRun` reports what would change without writing.
   */
  async provision(input: {
    operatorAccountId: string;
    manifest: CatalogManifest;
    dryRun?: boolean;
  }): Promise<CatalogProvisionReport> {
    const op = input.operatorAccountId;
    const dryRun = input.dryRun === true;
    // Validate the whole manifest before any write.
    for (const sport of input.manifest.sports) {
      if (!SPORT_CODE.test(sport.code))
        throw new DomainError(DomainErrorCode.INVALID_INPUT, `invalid sport code ${sport.code}`);
      for (const d of sport.disciplines) {
        if (!DISCIPLINE_CODE.test(d.code) || !disciplineBelongsToSport(d.code, sport.code))
          throw new DomainError(DomainErrorCode.INVALID_INPUT, `invalid discipline code ${d.code}`);
        if (d.specs.length === 0)
          throw new DomainError(DomainErrorCode.INVALID_INPUT, `no versions for ${d.code}`);
        for (const spec of d.specs) {
          const issues = validateDisciplineVersionSpec(spec);
          if (issues.length > 0)
            throw new DomainError(DomainErrorCode.INVALID_INPUT, `invalid spec for ${d.code}`, {
              issues: issues.slice(0, 20),
            });
        }
      }
    }
    const engines = input.manifest.formats.map((f) => {
      const versions = f.versions.map((v) => {
        const engine = formatEngine(v.engineId, v.engineVersion);
        if (engine === undefined)
          throw new DomainError(DomainErrorCode.INVALID_INPUT, `invalid format ${f.code}`);
        return { ...v, engine };
      });
      if (!FORMAT_CODE.test(f.code) || versions.length === 0)
        throw new DomainError(DomainErrorCode.INVALID_INPUT, `invalid format ${f.code}`);
      return { ...f, versions };
    });

    const steps: CatalogProvisionReport['steps'][number][] = [];
    const conflicts: { code: string; reason: string }[] = [];
    const key = (...parts: string[]) => `catalog-provision:${parts.join(':')}`;
    const idOf = (table: 'sport' | 'discipline' | 'format_template', code: string) =>
      this.tx(async (ctx) => {
        const { rows } = await sql<{
          id: string;
        }>`SELECT id FROM ${sql.raw(`sports.${table}`)} WHERE code = ${code}`.execute(ctx.trx);
        return rows[0]?.id;
      });
    const versionsOf = (kind: 'discipline' | 'format', parentId: string) =>
      this.tx(async (ctx) => {
        const { rows } =
          kind === 'discipline'
            ? await sql<VersionRow>`
              SELECT v.id, v.spec_hash, c.status FROM sports.discipline_version v
              JOIN sports.v_discipline_version_current c ON c.discipline_version_id = v.id
              WHERE v.discipline_id = ${parentId} ORDER BY v.version`.execute(ctx.trx)
            : await sql<VersionRow>`
              SELECT v.id, v.spec_hash, c.status FROM sports.format_version v
              JOIN sports.v_format_version_current c ON c.format_version_id = v.id
              WHERE v.template_id = ${parentId} ORDER BY v.version`.execute(ctx.trx);
        return rows;
      });
    /**
     * Reuse, publish or create the version carrying `specHash` under an existing parent. `history`
     * is the manifest's declared version history: every existing version must belong to it (else
     * a conflict), and a declared version that does not exist yet is created and published.
     */
    const ensureVersion = async (
      kind: 'discipline' | 'format',
      code: string,
      parentId: string | undefined,
      specHash: string,
      history: readonly string[],
      create: () => Promise<string>,
    ) => {
      const stepKind = kind === 'discipline' ? 'discipline-version' : 'format-version';
      const versions = parentId === undefined ? [] : await versionsOf(kind, parentId);
      const match = versions.find((v) => v.spec_hash === specHash);
      if (versions.some((v) => !history.includes(v.spec_hash))) {
        if (conflicts.some((c) => c.code === code)) return; // one report per discipline / format
        conflicts.push({
          code,
          reason: `existing ${kind} versions differ from the declared specification`,
        });
        return;
      }
      if (match?.status === 'RETIRED') {
        conflicts.push({ code, reason: `the matching ${kind} version is RETIRED` });
        return;
      }
      if (match?.status === 'PUBLISHED') {
        steps.push({ kind: stepKind, code, action: 'UNCHANGED', id: match.id });
        return;
      }
      if (dryRun) {
        steps.push({
          kind: stepKind,
          code,
          action: match === undefined ? 'WOULD_CREATE' : 'WOULD_PUBLISH',
          ...(match === undefined ? {} : { id: match.id }),
        });
        return;
      }
      const id = match?.id ?? (await create());
      if (kind === 'discipline')
        await this.publishDisciplineVersion({ operatorAccountId: op, disciplineVersionId: id });
      else await this.publishFormatVersion({ operatorAccountId: op, formatVersionId: id });
      steps.push({
        kind: stepKind,
        code,
        action: match === undefined ? 'CREATED' : 'PUBLISHED',
        id,
      });
    };
    /** Reuse the row with this code, or create it (or report that it would be created). */
    const ensure = async (
      kind: 'sport' | 'discipline' | 'format',
      code: string,
      existing: string | undefined,
      create: () => Promise<string>,
    ) => {
      if (existing !== undefined) {
        steps.push({ kind, code, action: 'UNCHANGED', id: existing });
        return existing;
      }
      if (dryRun) {
        steps.push({ kind, code, action: 'WOULD_CREATE' });
        return undefined;
      }
      const id = await create();
      steps.push({ kind, code, action: 'CREATED', id });
      return id;
    };

    for (const sport of input.manifest.sports) {
      const sportId = await ensure(
        'sport',
        sport.code,
        await idOf('sport', sport.code),
        async () =>
          (
            await this.createSport({
              operatorAccountId: op,
              code: sport.code,
              name: sport.name,
              idempotencyKey: key('sport', sport.code),
            })
          ).sportId,
      );
      for (const d of sport.disciplines) {
        const disciplineId = await ensure(
          'discipline',
          d.code,
          await idOf('discipline', d.code),
          async () =>
            (
              await this.createDiscipline({
                operatorAccountId: op,
                sportId: sportId as string,
                code: d.code,
                name: d.name,
                idempotencyKey: key('discipline', d.code),
              })
            ).disciplineId,
        );
        const history = d.specs.map((spec) => catalogSpecHash('br:discipline-version-spec', spec));
        for (const [i, spec] of d.specs.entries()) {
          const specHash = history[i] as string;
          await ensureVersion(
            'discipline',
            d.code,
            disciplineId,
            specHash,
            history,
            async () =>
              (
                await this.createDisciplineVersion({
                  operatorAccountId: op,
                  disciplineId: disciplineId as string,
                  spec,
                  idempotencyKey: key('discipline-version', d.code, specHash),
                })
              ).disciplineVersionId,
          );
        }
      }
    }
    for (const f of engines) {
      const templateId = await ensure(
        'format',
        f.code,
        await idOf('format_template', f.code),
        async () =>
          (
            await this.createFormatTemplate({
              operatorAccountId: op,
              code: f.code,
              name: f.name,
              idempotencyKey: key('format', f.code),
            })
          ).formatTemplateId,
      );
      const history = f.versions.map((v) => formatVersionSpecHash(v.engine));
      for (const [i, v] of f.versions.entries()) {
        const specHash = history[i] as string;
        await ensureVersion(
          'format',
          f.code,
          templateId,
          specHash,
          history,
          async () =>
            (
              await this.createFormatVersion({
                operatorAccountId: op,
                formatTemplateId: templateId as string,
                engineId: v.engineId,
                engineVersion: v.engineVersion,
                idempotencyKey: key('format-version', f.code, specHash),
              })
            ).formatVersionId,
        );
      }
    }
    return { steps, conflicts };
  }
}
