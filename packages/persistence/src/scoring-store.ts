import {
  crossGroupKeysUsed,
  type AdvancementPolicySpec,
  type ContestEvidence,
  capabilityIssues,
  engineRequirements,
  formatEngine,
  providedCapabilities,
  producedContestTypes,
  readContestContent,
  schedulingProfileCompatibility,
  schedulingProfileSpecHash,
  scoreContest,
  type SchedulingProfileSpec,
  type DisciplineVersionSpec,
  type RuleBasis,
  type RulesetSpec,
  type ScoreSheet,
  type ScoringContext,
} from '@br/competition';
import {
  DomainError,
  DomainErrorCode,
  newId,
  type ResultVersionContent,
  type Uuid,
} from '@br/domain';
import {
  classifyStage,
  type ClassificationPolicyV2Spec,
  type ClassificationV2Contest,
} from '@br/rankings';
import { sql } from 'kysely';
import { loadCompetition, loadEvent, requireCompPermission } from './competition-support';
import type { Db } from './db';
import { identityIdempotency, lockKeys, recordAudit } from './identity-support';
import { emitEvent } from './outbox';
import { hashResultContent } from './result-ledger';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * ONCF-05C scoring (ADR-0059, ADR-0060, ADR-0062, ADR-0063).
 *
 *  · pinScoring       which RulesetVersion (and ClassificationTemplateVersion) an event is scored
 *                     under, with per-stage overrides; capability-checked; frozen at field lock.
 *  · validateScoreSheet  a score sheet for one contest → canonical `@1` content + its ledger hash.
 *                     Pure: nothing is written. Submitting it is the ResultLedger's job (05D).
 *  · classify         a stage (or one group / rounds through k) ordered by classification-engine/2
 *                     from the CURRENT contest results at the template's minimum status. Every input
 *                     is re-derived and re-validated under the pinned ruleset — invalid content blocks
 *                     the classification (fail closed). Computed on read, hashed, never persisted
 *                     (ADR-0047: the engine proposes; an authority submits, in 05D).
 * Structure is read as br_competition and results as br_results, in separate read-only
 * transactions; neither role gains access to the other's tables.
 */

const HEAD_TO_HEAD_FAMILIES = new Set([
  'SETS_OF_GAMES',
  'TIMED_PERIODS',
  'TIMED_OR_TARGET',
  'MATCH_PLAY_HOLES',
]);
const STATUS_FLOOR: Record<string, readonly string[]> = {
  PROVISIONAL: ['PROVISIONAL', 'OFFICIAL', 'FINAL'],
  OFFICIAL: ['OFFICIAL', 'FINAL'],
  FINAL: ['FINAL'],
};

interface Pinned {
  readonly rulesetVersionId: string;
  readonly classificationTemplateVersionId: string | null;
  readonly advancementPolicyVersionId: string | null;
  readonly schedulingProfileVersionId: string | null;
  readonly stageOverrides: Readonly<
    Record<string, { rulesetVersionId?: string; classificationTemplateVersionId?: string }>
  >;
}

interface VersionRow {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly family: string;
  readonly spec: unknown;
  readonly spec_hash: string;
  readonly basis: RuleBasis;
  readonly status: string;
}

async function rulesetVersion(ctx: TxContext, id: string): Promise<VersionRow | undefined> {
  const { rows } = await sql<VersionRow>`
    SELECT v.id, r.code, v.version, v.family, v.spec, v.spec_hash, v.basis, c.status
    FROM sports.ruleset_version v JOIN sports.ruleset r ON r.id = v.ruleset_id
    JOIN sports.v_ruleset_version_current c ON c.ruleset_version_id = v.id WHERE v.id = ${id}`.execute(
    ctx.trx,
  );
  return rows[0];
}

async function templateVersion(ctx: TxContext, id: string): Promise<VersionRow | undefined> {
  const { rows } = await sql<VersionRow>`
    SELECT v.id, t.code, v.version, v.family, v.spec, v.spec_hash, v.basis, c.status
    FROM sports.classification_template_version v JOIN sports.classification_template t ON t.id = v.template_id
    JOIN sports.v_classification_template_version_current c ON c.classification_template_version_id = v.id
    WHERE v.id = ${id}`.execute(ctx.trx);
  return rows[0];
}

export async function advancementPolicyVersion(
  ctx: TxContext,
  id: string,
): Promise<VersionRow | undefined> {
  const { rows } = await sql<VersionRow>`
    SELECT v.id, p.code, v.version, v.family, v.spec, v.spec_hash, v.basis, c.status
    FROM sports.advancement_policy_version v JOIN sports.advancement_policy p ON p.id = v.policy_id
    JOIN sports.v_advancement_policy_version_current c ON c.advancement_policy_version_id = v.id
    WHERE v.id = ${id}`.execute(ctx.trx);
  return rows[0];
}

/** ONCF-05E-B: a SchedulingProfile version row (its shape version instead of a family). */
interface ProfileRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly spec_version: number;
  readonly spec: SchedulingProfileSpec;
  readonly spec_hash: string;
  readonly basis: RuleBasis;
  readonly status: string;
}

export async function schedulingProfileVersion(
  ctx: TxContext,
  id: string,
): Promise<ProfileRow | undefined> {
  const { rows } = await sql<ProfileRow>`
    SELECT v.id, p.code, p.name, v.version, v.spec_version, v.spec, v.spec_hash, v.basis, c.status
    FROM sports.scheduling_profile_version v JOIN sports.scheduling_profile p ON p.id = v.profile_id
    JOIN sports.v_scheduling_profile_version_current c ON c.scheduling_profile_version_id = v.id
    WHERE v.id = ${id}`.execute(ctx.trx);
  return rows[0];
}

/** A pinned profile as served: a reference to the catalog version, never a copy owned by the event. */
const profileView = (v: ProfileRow) => ({
  versionId: v.id,
  code: v.code,
  name: v.name,
  version: v.version,
  specVersion: v.spec_version,
  specHash: v.spec_hash,
  spec: v.spec,
  basis: v.basis,
  status: v.status,
});

export async function currentPin(ctx: TxContext, eventId: string): Promise<Pinned | undefined> {
  const { rows } = await sql<{
    ruleset_version_id: string;
    classification_template_version_id: string | null;
    advancement_policy_version_id: string | null;
    scheduling_profile_version_id: string | null;
    stage_overrides: Pinned['stageOverrides'];
  }>`SELECT ruleset_version_id, classification_template_version_id, advancement_policy_version_id,
            scheduling_profile_version_id, stage_overrides
     FROM competition.v_event_scoring_current WHERE event_id = ${eventId}`.execute(ctx.trx);
  const r = rows[0];
  return r === undefined
    ? undefined
    : {
        rulesetVersionId: r.ruleset_version_id,
        classificationTemplateVersionId: r.classification_template_version_id,
        advancementPolicyVersionId: r.advancement_policy_version_id,
        schedulingProfileVersionId: r.scheduling_profile_version_id,
        stageOverrides: r.stage_overrides,
      };
}

/** Value keys a STANDINGS classification document carries (base values + criteria metrics). */
function standingsValueKeys(spec: ClassificationPolicyV2Spec): Set<string> {
  const keys = new Set(['played', 'wins', 'points']);
  const walk = (cs: readonly unknown[]) => {
    for (const raw of cs) {
      const c = raw as Record<string, unknown>;
      for (const k of ['forMetric', 'againstMetric', 'metric'])
        if (typeof c[k] === 'string') keys.add(c[k] as string);
      if (Array.isArray(c['sub'])) walk(c['sub'] as unknown[]);
    }
  };
  if (spec.family === 'STANDINGS') walk(spec.criteria);
  return keys;
}

const view = (v: VersionRow) => ({
  versionId: v.id,
  code: v.code,
  version: v.version,
  family: v.family,
  specHash: v.spec_hash,
  spec: v.spec,
  basis: v.basis,
});

export class ScoringStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private tx<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.competition, fn);
  }

  // ───────────────────────────── pin ─────────────────────────────

  /**
   * Pins the scoring of an event (COMP_EDIT) while its settings are editable (before the field
   * locks); afterwards scoring is frozen. Every pinned version must be PUBLISHED; the ruleset family
   * must be one the discipline provides and satisfy the format's ruleset requirement; a template
   * must fit the ruleset (STANDINGS ↔ head-to-head families, METRIC ↔ field families).
   */
  async pinScoring(input: {
    actorAccountId: string;
    eventId: string;
    rulesetVersionId: string;
    classificationTemplateVersionId?: string | null;
    /** ONCF-05D: how classified entrants move to dependent slots (required for advancement). */
    advancementPolicyVersionId?: string | null;
    /**
     * ONCF-05E-B (ADR-0072 §3): the PUBLISHED SchedulingProfile version, by id (never copied). A new
     * pin replaces the previous one (append-only); like every axis it is frozen at field lock.
     */
    schedulingProfileVersionId?: string | null;
    stageOverrides?: Readonly<
      Record<string, { rulesetVersionId?: string; classificationTemplateVersionId?: string }>
    >;
    idempotencyKey: string;
  }): Promise<{ eventId: string; created: boolean }> {
    const overrides = input.stageOverrides ?? {};
    for (const [stage, o] of Object.entries(overrides))
      if (
        !/^s[0-9]{1,2}$/.test(stage) ||
        typeof o !== 'object' ||
        o === null ||
        Object.keys(o).some(
          (k) => k !== 'rulesetVersionId' && k !== 'classificationTemplateVersionId',
        )
      )
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid stage override');
    return this.tx(async (ctx) => {
      const idem = await identityIdempotency<{ eventId: string }>(ctx, {
        command: 'PinEventScoring',
        actorAccountId: input.actorAccountId,
        idempotencyKey: input.idempotencyKey,
        params: {
          eventId: input.eventId,
          rulesetVersionId: input.rulesetVersionId,
          classificationTemplateVersionId: input.classificationTemplateVersionId ?? null,
          advancementPolicyVersionId: input.advancementPolicyVersionId ?? null,
          schedulingProfileVersionId: input.schedulingProfileVersionId ?? null,
          overrides,
        },
      });
      if (idem.lookup.replay) return { ...idem.lookup.response, created: false };
      await lockKeys(ctx, `event-structure:${input.eventId}`);
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_EDIT',
      );
      if (!['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(e.status))
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'scoring is frozen once the field is locked',
        );
      const { rows: dvRows } = await sql<{ spec: DisciplineVersionSpec }>`
        SELECT spec FROM sports.discipline_version WHERE id = ${e.disciplineVersionId}`.execute(
        ctx.trx,
      );
      const { rows: fvRows } = await sql<{ engine_id: string; engine_version: number }>`
        SELECT engine_id, engine_version FROM sports.format_version WHERE id = ${e.formatVersionId}`.execute(
        ctx.trx,
      );
      const provided = providedCapabilities(dvRows[0]?.spec as DisciplineVersionSpec);
      const engine =
        fvRows[0] === undefined
          ? undefined
          : formatEngine(fvRows[0].engine_id, fvRows[0].engine_version);
      const requiredFamilies =
        engine === undefined ? undefined : engineRequirements(engine).rulesetFamilies?.anyOf;
      const checkRuleset = async (id: string) => {
        const r = await rulesetVersion(ctx, id);
        if (r === undefined || r.status !== 'PUBLISHED')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'ruleset version not found or not published',
          );
        const gaps = capabilityIssues(provided, {
          rulesetFamilies: { anyOf: [r.family as RulesetSpec['family']] },
        });
        if (gaps.length > 0)
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `the discipline does not provide the ${r.family} ruleset family`,
            {
              reason: 'CAPABILITY_MISMATCH',
            },
          );
        if (
          requiredFamilies !== undefined &&
          !requiredFamilies.includes(r.family as RulesetSpec['family'])
        )
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `this format requires ruleset family ${requiredFamilies.join(' or ')}`,
            {
              reason: 'CAPABILITY_MISMATCH',
            },
          );
        return r;
      };
      const checkTemplate = async (id: string, ruleset: VersionRow): Promise<VersionRow> => {
        const t = await templateVersion(ctx, id);
        if (t === undefined || t.status !== 'PUBLISHED')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'classification template version not found or not published',
          );
        const h2h = HEAD_TO_HEAD_FAMILIES.has(ruleset.family);
        if ((t.family === 'STANDINGS') !== h2h)
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `a ${t.family} template does not fit a ${ruleset.family} ruleset`,
            {
              reason: 'CAPABILITY_MISMATCH',
            },
          );
        return t;
      };
      const base = await checkRuleset(input.rulesetVersionId);
      const baseTemplate =
        input.classificationTemplateVersionId !== undefined &&
        input.classificationTemplateVersionId !== null
          ? await checkTemplate(input.classificationTemplateVersionId, base)
          : undefined;
      if (
        input.advancementPolicyVersionId !== undefined &&
        input.advancementPolicyVersionId !== null
      ) {
        const a = await advancementPolicyVersion(ctx, input.advancementPolicyVersionId);
        if (a === undefined || a.status !== 'PUBLISHED')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'advancement policy version not found or not published',
          );
        // A cross-group order can only read values the pinned standings template produces.
        const used = crossGroupKeysUsed(a.spec as AdvancementPolicySpec);
        if (used.length > 0) {
          const available =
            baseTemplate === undefined
              ? new Set<string>()
              : standingsValueKeys(baseTemplate.spec as ClassificationPolicyV2Spec);
          const missing = used.filter((k) => !available.has(k));
          if (missing.length > 0)
            throw new DomainError(
              DomainErrorCode.INVALID_INPUT,
              `the advancement policy compares values the classification template does not produce: ${missing.join(', ')}`,
              { reason: 'CAPABILITY_MISMATCH' },
            );
        }
      }
      if (
        input.schedulingProfileVersionId !== undefined &&
        input.schedulingProfileVersionId !== null
      ) {
        const p = await schedulingProfileVersion(ctx, input.schedulingProfileVersionId);
        if (p === undefined || p.status !== 'PUBLISHED')
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            'scheduling profile version not found or not published',
          );
        // Pin-time compatibility (ADR-0069 §4, ADR-0072 §6) from data only: the discipline declares
        // every required resource type and the format's contest types are covered. The stored spec
        // is re-validated and its hash re-derived (fail closed).
        const gaps =
          schedulingProfileSpecHash(p.spec) === p.spec_hash
            ? schedulingProfileCompatibility(
                p.spec,
                provided,
                engine === undefined ? [] : producedContestTypes(engine, provided.contestTypes),
              )
            : [{ capability: 'spec' as const, message: 'stored spec does not match its hash' }];
        if (gaps.length > 0)
          throw new DomainError(
            DomainErrorCode.INVALID_INPUT,
            `the scheduling profile is not compatible with this category: ${gaps.map((g) => g.message).join('; ')}`,
            { reason: 'CAPABILITY_MISMATCH', issues: gaps },
          );
      }
      for (const o of Object.values(overrides)) {
        const r = o.rulesetVersionId === undefined ? base : await checkRuleset(o.rulesetVersionId);
        if (o.classificationTemplateVersionId !== undefined)
          await checkTemplate(o.classificationTemplateVersionId, r);
      }
      await sql`INSERT INTO competition.event_scoring (id, event_id, ruleset_version_id, classification_template_version_id, advancement_policy_version_id,
                                                       scheduling_profile_version_id, stage_overrides, pinned_by_account_id, recorded_at)
        VALUES (${newId()}, ${e.id}, ${input.rulesetVersionId}, ${input.classificationTemplateVersionId ?? null},
                ${input.advancementPolicyVersionId ?? null}, ${input.schedulingProfileVersionId ?? null},
                ${JSON.stringify(overrides)}::jsonb, ${input.actorAccountId}, ${ctx.txTime})`.execute(
        ctx.trx,
      );
      await emitEvent(ctx, {
        eventType: 'EventScoringPinned',
        aggregateType: 'EVENT',
        aggregateId: e.id as Uuid,
        payload: {
          rulesetVersionId: input.rulesetVersionId,
          classificationTemplateVersionId: input.classificationTemplateVersionId ?? null,
          advancementPolicyVersionId: input.advancementPolicyVersionId ?? null,
          schedulingProfileVersionId: input.schedulingProfileVersionId ?? null,
        },
      });
      await recordAudit(ctx, {
        actorAccountId: input.actorAccountId,
        action: 'event.scoring-pinned',
        targetType: 'EVENT',
        targetId: e.id,
        details: {
          rulesetVersionId: input.rulesetVersionId,
          ...(input.schedulingProfileVersionId === undefined ||
          input.schedulingProfileVersionId === null
            ? {}
            : { schedulingProfileVersionId: input.schedulingProfileVersionId }),
          overrides: Object.keys(overrides).length,
        },
      });
      await idem.record({ eventId: e.id });
      return { eventId: e.id, created: true };
    });
  }

  /** The event's pinned scoring with the full versions (COMP_VIEW_PRIVATE). */
  scoring(input: { actorAccountId: string; eventId: string }) {
    return this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
      const pin = await currentPin(ctx, e.id);
      if (pin === undefined)
        return {
          eventId: e.id,
          pinned: false as const,
          frozen: !['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(e.status),
        };
      const ruleset = await rulesetVersion(ctx, pin.rulesetVersionId);
      const template =
        pin.classificationTemplateVersionId === null
          ? undefined
          : await templateVersion(ctx, pin.classificationTemplateVersionId);
      const policy =
        pin.advancementPolicyVersionId === null
          ? undefined
          : await advancementPolicyVersion(ctx, pin.advancementPolicyVersionId);
      const profile =
        pin.schedulingProfileVersionId === null
          ? undefined
          : await schedulingProfileVersion(ctx, pin.schedulingProfileVersionId);
      return {
        eventId: e.id,
        pinned: true as const,
        frozen: !['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(e.status),
        ruleset: ruleset === undefined ? null : view(ruleset),
        classificationTemplate: template === undefined ? null : view(template),
        advancementPolicy: policy === undefined ? null : view(policy),
        schedulingProfile: profile === undefined ? null : profileView(profile),
        stageOverrides: pin.stageOverrides,
      };
    });
  }

  // ───────────────────────────── contest context ─────────────────────────────

  private async contestContext(ctx: TxContext, contestId: string) {
    const { rows } = await sql<{
      event_id: string;
      round_sequence: number;
      stage_key: string | null;
      group_key: string | null;
    }>`
      SELECT c.event_id, r.sequence AS round_sequence, st.plan_key AS stage_key, r.group_key
      FROM competition.contest c JOIN competition.round r ON r.id = c.round_id
      LEFT JOIN competition.stage st ON st.id = r.stage_id WHERE c.id = ${contestId}`.execute(
      ctx.trx,
    );
    const c = rows[0];
    if (c === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'contest not found');
    const pin = await currentPin(ctx, c.event_id);
    if (pin === undefined)
      throw new DomainError(DomainErrorCode.INVALID_TRANSITION, 'the event has no pinned scoring', {
        reason: 'SCORING_NOT_PINNED',
      });
    const override = c.stage_key === null ? undefined : pin.stageOverrides[c.stage_key];
    const ruleset = await rulesetVersion(ctx, override?.rulesetVersionId ?? pin.rulesetVersionId);
    if (ruleset === undefined)
      throw new DomainError(DomainErrorCode.NOT_FOUND, 'pinned ruleset not found');
    // ONCF-05D: dependent places read their CURRENT occupant (resolution facts; null = unresolved
    // or decided vacant). A contest whose every place is decided vacant is not part of the field.
    const { rows: slots } = await sql<{
      source_kind: string;
      participant_id: string | null;
      assignment_id: string | null;
    }>`
      SELECT source_kind, participant_id, assignment_id FROM competition.v_contest_occupant
      WHERE contest_id = ${contestId} ORDER BY place`.execute(ctx.trx);
    const { rows: entries } = await sql<{ participant_id: string }>`
      SELECT participant_id FROM competition.contest_entry WHERE contest_id = ${contestId} ORDER BY start_order`.execute(
      ctx.trx,
    );
    const vacant =
      slots.length > 0 && slots.every((s) => s.participant_id === null && s.assignment_id !== null);
    const { rows: dynamicRows } = await sql<{ dynamic: boolean }>`
      SELECT r.dynamic_transition_key IS NOT NULL AS dynamic FROM competition.contest c
      JOIN competition.round r ON r.id = c.round_id WHERE c.id = ${contestId}`.execute(ctx.trx);
    const unresolved =
      !vacant &&
      (slots.some((s) => s.participant_id === null) ||
        (dynamicRows[0]?.dynamic === true && slots.length === 0));
    const participants = [
      ...slots.flatMap((s) => (s.participant_id === null ? [] : [s.participant_id])),
      ...entries.map((x) => x.participant_id),
    ];
    const { rows: roster } = await sql<{ participant_id: string; athlete_id: string }>`
      SELECT participant_id, athlete_id FROM competition.participant_roster_member
      WHERE participant_id = ANY(${participants}::uuid[]) ORDER BY participant_id, athlete_id`.execute(
      ctx.trx,
    );
    const { rows: attrs } = await sql<{
      participant_id: string;
      attribute_key: string;
      athlete_id: string | null;
      value: string;
    }>`
      SELECT participant_id, attribute_key, athlete_id, value FROM competition.participant_entry_attribute
      WHERE participant_id = ANY(${participants}::uuid[])`.execute(ctx.trx);
    const rosters: Record<string, string[]> = {};
    for (const r of roster) (rosters[r.participant_id] ??= []).push(r.athlete_id);
    const attributes: Record<string, Record<string, string>> = {};
    const memberAttributes: Record<string, Record<string, Record<string, string>>> = {};
    for (const a of attrs) {
      if (a.athlete_id === null) (attributes[a.participant_id] ??= {})[a.attribute_key] = a.value;
      else
        ((memberAttributes[a.participant_id] ??= {})[a.athlete_id] ??= {})[a.attribute_key] =
          a.value;
    }
    const scoring: ScoringContext = {
      ruleset: ruleset.spec as RulesetSpec,
      mode: HEAD_TO_HEAD_FAMILIES.has(ruleset.family) ? 'HEAD_TO_HEAD' : 'FIELD',
      participants,
      rosters,
      attributes,
      memberAttributes,
    };
    return {
      eventId: c.event_id,
      roundSequence: c.round_sequence,
      stageKey: c.stage_key,
      groupKey: c.group_key,
      unresolved,
      vacant,
      ruleset,
      scoring,
    };
  }

  /**
   * Validates a score sheet for one contest under its pinned ruleset (COMP_VIEW_PRIVATE). Returns
   * the canonical `@1` content and the content hash the ResultLedger would compute, or coded issues.
   * Nothing is written.
   */
  validateScoreSheet(input: { actorAccountId: string; contestId: string; sheet: ScoreSheet }) {
    return this.tx(async (ctx) => {
      const c = await this.contestContext(ctx, input.contestId);
      const e = await loadEvent(ctx, c.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
      if (c.unresolved)
        return {
          ok: false as const,
          issues: [
            {
              path: '',
              code: 'CONTEST_NOT_READY',
              message: 'the contest still has unresolved slots',
            },
          ],
        };
      const out = scoreContest(c.scoring, input.sheet);
      if (!out.ok) return { ok: false as const, issues: out.issues };
      return {
        ok: true as const,
        ruleset: {
          versionId: c.ruleset.id,
          code: c.ruleset.code,
          version: c.ruleset.version,
          specHash: c.ruleset.spec_hash,
        },
        content: out.content,
        contentHash: hashResultContent(out.content).contentHash,
        result: out.result,
      };
    });
  }

  // ───────────────────────────── classification ─────────────────────────────

  /**
   * Classification of one stage scope under the pinned template (COMP_VIEW_PRIVATE). Groups must
   * be named for grouped stages. Contests without an admissible current result, or with unresolved
   * slots, are PENDING (the document says `complete: false`); a stored result that does not
   * re-validate under the ruleset blocks the whole classification (CONTEST_RESULT_INVALID).
   */
  async classify(input: {
    actorAccountId: string;
    eventId: string;
    stageKey: string;
    groupKey?: string;
    throughRound?: number;
  }) {
    await this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      await requireCompPermission(
        ctx,
        input.actorAccountId,
        await loadCompetition(ctx, e.competitionId),
        'COMP_VIEW_PRIVATE',
      );
    });
    return this.classification(input);
  }

  /**
   * ONCF-05D: the same classification at an explicit result-status floor (the advancement policy's
   * minimum — OFFICIAL by default — instead of the template's). NOT authorization-checked: called
   * only by AdvancementStore after its own COMP_* check; never exposed as a route.
   */
  classificationAt(input: {
    eventId: string;
    stageKey: string;
    groupKey?: string;
    throughRound?: number;
    floor: 'OFFICIAL' | 'PROVISIONAL';
  }) {
    return this.classification(input);
  }

  private async classification(input: {
    eventId: string;
    stageKey: string;
    groupKey?: string;
    throughRound?: number;
    floor?: 'OFFICIAL' | 'PROVISIONAL';
  }) {
    const structure = await this.tx(async (ctx) => {
      const e = await loadEvent(ctx, input.eventId);
      const pin = await currentPin(ctx, e.id);
      if (pin === undefined)
        throw new DomainError(
          DomainErrorCode.INVALID_TRANSITION,
          'the event has no pinned scoring',
          { reason: 'SCORING_NOT_PINNED' },
        );
      const templateId =
        pin.stageOverrides[input.stageKey]?.classificationTemplateVersionId ??
        pin.classificationTemplateVersionId;
      if (templateId === null)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'no classification template is pinned for this stage',
          { reason: 'TEMPLATE_NOT_PINNED' },
        );
      const template = await templateVersion(ctx, templateId);
      if (template === undefined)
        throw new DomainError(DomainErrorCode.NOT_FOUND, 'classification template not found');
      const { rows: stage } = await sql<{ id: string; partition_kind: string | null }>`
        SELECT id, partition_kind FROM competition.stage WHERE event_id = ${e.id} AND plan_key = ${input.stageKey}`.execute(
        ctx.trx,
      );
      const st = stage[0];
      if (st === undefined) throw new DomainError(DomainErrorCode.NOT_FOUND, 'stage not found');
      const { rows: groups } = await sql<{ n: number }>`
        SELECT count(DISTINCT group_key)::int AS n FROM competition.round WHERE stage_id = ${st.id} AND group_key IS NOT NULL`.execute(
        ctx.trx,
      );
      if ((groups[0]?.n ?? 0) > 0 && input.groupKey === undefined)
        throw new DomainError(DomainErrorCode.INVALID_INPUT, 'name the group to classify', {
          reason: 'GROUP_REQUIRED',
        });
      const { rows: contests } = await sql<{ id: string; round_sequence: number }>`
        SELECT c.id, r.sequence AS round_sequence FROM competition.contest c JOIN competition.round r ON r.id = c.round_id
        WHERE r.stage_id = ${st.id} AND (${input.groupKey ?? null}::text IS NULL OR r.group_key = ${input.groupKey ?? null})
        ORDER BY r.sequence, c.sequence`.execute(ctx.trx);
      const contexts = [];
      // Rounds after `throughRound` are outside the scope (a cut reads rounds 1..k only, even once
      // the post-cut rounds exist).
      for (const c of contests.filter(
        (x) => input.throughRound === undefined || x.round_sequence <= input.throughRound,
      )) {
        const context = await this.contestContext(ctx, c.id);
        // A contest decided vacant (its field place no longer selected) is not part of the stage.
        if (!context.vacant) contexts.push({ contestId: c.id, ...context });
      }
      const { rows: seeding } = await sql<{ seed_order: string[] }>`
        SELECT seed_order FROM competition.event_seeding WHERE event_id = ${e.id}`.execute(ctx.trx);
      const spec = template.spec as ClassificationPolicyV2Spec;
      const keys = new Set<string>([
        ...(spec.family === 'METRIC' ? (spec.subsetsByAttribute ?? []) : []),
        ...(spec.family === 'METRIC' && spec.teamDerived !== undefined
          ? [spec.teamDerived.groupByAttribute]
          : []),
      ]);
      const participants = [...new Set(contexts.flatMap((c) => c.scoring.participants))];
      const attributes: Record<string, Record<string, string>> = {};
      for (const c of contexts)
        for (const [pid, a] of Object.entries(c.scoring.attributes ?? {}))
          for (const [k, v] of Object.entries(a)) if (keys.has(k)) (attributes[pid] ??= {})[k] = v;
      return {
        e,
        template,
        spec,
        contexts,
        participants,
        attributes,
        seedOrder: seeding[0]?.seed_order,
      };
    });
    const floor =
      STATUS_FLOOR[input.floor ?? structure.spec.minimumInputStatus] ??
      STATUS_FLOOR['PROVISIONAL'] ??
      [];
    const contestIds = structure.contexts.map((c) => c.contestId);
    const current = await inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const { rows } = await sql<{
        contest_id: string;
        result_version_id: string;
        content: ResultVersionContent;
        content_hash: string;
        status: string;
      }>`
        SELECT r.scope_target_id AS contest_id, v.id AS result_version_id, v.content, v.content_hash, t.to_status AS status
        FROM results.result r
        JOIN results.result_version v ON v.result_id = r.id
        JOIN LATERAL (SELECT x.to_status FROM results.result_status_transition x
                      WHERE x.result_version_id = v.id ORDER BY x.recorded_at DESC, x.id DESC LIMIT 1) t ON true
        WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ANY(${contestIds}::uuid[])
          AND t.to_status = ANY(${[...floor]}::text[])
          AND NOT EXISTS (SELECT 1 FROM results.result_version s WHERE s.supersedes_version_id = v.id)
        ORDER BY v.recorded_at DESC, v.id DESC`.execute(ctx.trx);
      const latest = new Map<string, (typeof rows)[number]>();
      for (const r of rows) if (!latest.has(r.contest_id)) latest.set(r.contest_id, r);
      return latest;
    });
    const inputs: ClassificationV2Contest[] = [];
    const pending: string[] = [];
    const invalid: { contestId: string; issues: readonly { code: string; message: string }[] }[] =
      [];
    for (const c of structure.contexts) {
      const r = current.get(c.contestId);
      if (c.unresolved || r === undefined) {
        pending.push(c.contestId);
        continue;
      }
      const read = readContestContent(c.scoring, r.content);
      if (!read.ok) {
        invalid.push({
          contestId: c.contestId,
          issues: read.issues.map((i) => ({ code: i.code, message: i.message })),
        });
        continue;
      }
      inputs.push({
        contestId: c.contestId,
        roundSequence: c.roundSequence,
        resultVersionId: r.result_version_id,
        contentHash: r.content_hash,
        result: read.result,
      });
    }
    if (invalid.length > 0)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'a stored contest result does not validate under the pinned ruleset',
        {
          reason: 'CONTEST_RESULT_INVALID',
          contests: invalid.slice(0, 20),
        },
      );
    const out = classifyStage({
      policy: structure.spec,
      policyRef: {
        code: structure.template.code,
        version: structure.template.version,
        specHash: structure.template.spec_hash,
      },
      scope: {
        eventId: structure.e.id,
        stageKey: input.stageKey,
        ...(input.groupKey === undefined ? {} : { groupKey: input.groupKey }),
        ...(input.throughRound === undefined ? {} : { throughRound: input.throughRound }),
      },
      participants: structure.participants,
      contests: inputs,
      pendingContests: pending,
      ...(structure.seedOrder === undefined ? {} : { seedOrder: structure.seedOrder }),
      attributes: structure.attributes,
    });
    if (!out.ok)
      throw new DomainError(
        DomainErrorCode.INVALID_INPUT,
        'the classification cannot be computed',
        { reason: 'CLASSIFICATION_REFUSED', issues: out.issues.slice(0, 20) },
      );
    return { document: out.document, hash: out.hash, pendingContests: pending };
  }

  /**
   * ONCF-05D: the current result of each contest, re-validated under its pinned ruleset (the same
   * fail-closed read-back as classification). `admissible` at the floor; `below` = the status of a
   * current version that exists but is below the floor (e.g. PROVISIONAL when OFFICIAL is required).
   * NOT authorization-checked (AdvancementStore only).
   */
  async contestEvidence(
    contestIds: readonly string[],
    floorStatus: 'OFFICIAL' | 'PROVISIONAL',
  ): Promise<{ admissible: Map<string, ContestEvidence>; below: Map<string, string> }> {
    const contexts = await this.tx(async (ctx) => {
      const out = new Map<string, Awaited<ReturnType<ScoringStore['contestContext']>>>();
      for (const id of contestIds) out.set(id, await this.contestContext(ctx, id));
      return out;
    });
    const floor = STATUS_FLOOR[floorStatus] ?? [];
    const rows = await inTransaction(this.db, ModuleRole.results, async (ctx) => {
      const { rows } = await sql<{
        contest_id: string;
        result_version_id: string;
        content: ResultVersionContent;
        content_hash: string;
        status: string;
      }>`
        SELECT r.scope_target_id AS contest_id, v.id AS result_version_id, v.content, v.content_hash, st.current_status AS status
        FROM results.result r
        JOIN results.result_state rs ON rs.result_id = r.id
        JOIN results.result_version v ON v.id = rs.current_version_id
        JOIN results.result_version_state st ON st.result_version_id = v.id
        WHERE r.scope_type = 'CONTEST' AND r.scope_target_id = ANY(${[...contestIds]}::uuid[])
        ORDER BY r.scope_target_id, r.recorded_at DESC, r.id DESC`.execute(ctx.trx);
      return rows;
    });
    const admissible = new Map<string, ContestEvidence>();
    const below = new Map<string, string>();
    for (const r of rows) {
      if (admissible.has(r.contest_id) || below.has(r.contest_id)) continue;
      if (!floor.includes(r.status)) {
        below.set(r.contest_id, r.status);
        continue;
      }
      const c = contexts.get(r.contest_id);
      if (c === undefined || c.unresolved) continue;
      const read = readContestContent(c.scoring, r.content);
      if (!read.ok)
        throw new DomainError(
          DomainErrorCode.INVALID_INPUT,
          'a stored contest result does not validate under the pinned ruleset',
          { reason: 'CONTEST_RESULT_INVALID', contests: [{ contestId: r.contest_id }] },
        );
      admissible.set(r.contest_id, {
        resultVersionId: r.result_version_id,
        contentHash: r.content_hash,
        status: r.status,
        result: read.result,
      });
    }
    return { admissible, below };
  }
}
