import {
  HALL_OF_FAME_NOTICE,
  PUBLIC_RECORD_NOTICE,
  publicRecordReason,
  recordStatusLabel,
  recordStatusStatement,
  recordSupportStatement,
} from '@br/records';
import {
  RECORD_SCOPE_TYPES,
  VERIFICATION_LEVEL_LABEL,
  type Mark,
  type RecordMarkStatus,
  type VerificationLevel,
} from '@br/domain';
import { sql } from 'kysely';
import type { Db } from './db';
import { liveRecordSupport } from './record-store';
import { inTransaction, ModuleRole, type TxContext } from './tx';

/**
 * BRT-09 public-safe record reads (br_public_read over record_read projections). DTOs carry public
 * sporting identities (athlete through the Passport privacy policy; team name), values, labels,
 * effective periods, statuses, recognition LEVEL / region / sport — never anchor ids, anchor fact
 * hashes, grant chains, principal ids, keys, attestation topology, evidence refs, Person / Account
 * ids, DOB, e-mail or wallets. Only CANONICAL_ASSEMBLY rows are ever public.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const MAX_PAGE = 50;

export interface PublicAthleteRef {
  readonly privateEntrant?: true;
  readonly athleteId?: string;
  readonly slug?: string;
  readonly displayName?: string;
}

export type PublicHolder =
  | { readonly holderType: 'ATHLETE'; readonly athlete: PublicAthleteRef }
  | {
      readonly holderType: 'TEAM';
      readonly team: { readonly teamId: string; readonly name?: string };
    };

export interface PublicRecordMarkV1 {
  readonly schema: 'br:public-record-mark@1';
  readonly recordMarkId: string;
  readonly recordLabel: string;
  readonly category: {
    readonly code: string;
    readonly name: string;
    readonly version: number;
    readonly scopeType: string;
  };
  readonly metric: string;
  readonly value: Mark & { readonly display: string };
  readonly holder: PublicHolder;
  readonly memberCredits?: readonly {
    readonly creditType: 'TEAM_MEMBER';
    readonly athlete: PublicAthleteRef;
  }[];
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly holding: 'CURRENT' | 'FORMER' | 'NOT_A_RECORD';
  readonly status: RecordMarkStatus;
  readonly statusLabel: string;
  readonly statusStatement: string;
  readonly statusReasons: readonly { readonly code: string; readonly explanation: string }[];
  readonly recognition: {
    readonly level: string;
    readonly region?: readonly string[];
    readonly sport?: string;
    readonly discipline?: string;
  };
  readonly verification: {
    readonly basisLevelAtEstablishment: VerificationLevel;
    readonly levelAtRatification?: VerificationLevel;
    readonly statement: string;
  };
  readonly ratification: {
    readonly state: 'NOT_RATIFIED' | 'RATIFIED' | 'CANONICAL';
    readonly ratifiedAt?: string;
    readonly statement: string;
  };
  readonly currentSupport?: {
    readonly support: 'SUPPORTED' | 'SUSPENDED' | 'INVALIDATED';
    readonly statement: string;
    readonly reasons: readonly { readonly code: string; readonly explanation: string }[];
  };
  readonly recordSetAchievementId?: string;
  readonly supersededByMarkId?: string;
  readonly competition: { readonly competitionId: string; readonly name?: string };
  readonly notice: string;
}

interface MarkCardRow {
  record_mark_id: string;
  category_id: string;
  category_code: string;
  category_version: number;
  scope_type: string;
  display_name: string;
  record_label: string;
  holder_type: 'ATHLETE' | 'TEAM';
  holder_id: string;
  member_athlete_ids: string[];
  value: Mark;
  mark_metric_id: string;
  effective_from: Date;
  effective_to: Date | null;
  status: RecordMarkStatus;
  standing: string | null;
  status_reasons: string[];
  is_current: boolean;
  ever_held: boolean;
  ratified_at: Date | null;
  superseded_by_mark_id: string | null;
  region: string[] | null;
  recognition_level: string;
  sport_code: string | null;
  discipline_code: string | null;
  basis_level: VerificationLevel;
  ratification_level: VerificationLevel | null;
  competition_id: string;
  category_name: string;
  competition_name: string | null;
  record_set_achievement_id: string | null;
}

const MARK_SELECT = sql`
  SELECT c.*, cat.name AS category_name, cc.name AS competition_name, l.record_set_achievement_id
  FROM record_read.mark_card c
  JOIN record_read.category_card cat ON cat.category_id = c.category_id
  LEFT JOIN competition_read.competition_card cc ON cc.competition_id = c.competition_id AND cc.status <> 'DRAFT'
  LEFT JOIN record_read.v_record_set_link l ON l.record_mark_id = c.record_mark_id
  WHERE c.provenance = 'CANONICAL_ASSEMBLY'`;

/** Athlete display through the Passport privacy policy: restricted / private athletes are never named. */
async function athleteRefs(ctx: TxContext, ids: readonly string[]) {
  const out = new Map<string, PublicAthleteRef>(ids.map((id) => [id, { privateEntrant: true }]));
  if (ids.length === 0) return out;
  const { rows } = await sql<{ athlete_id: string; slug: string; display_name: string }>`
    SELECT athlete_id, slug, display_name FROM passport.athlete_card
    WHERE athlete_id = ANY(${[...ids]}::uuid[]) AND profile_visibility = 'PUBLIC' AND NOT restricted
      AND athlete_status = 'ACTIVE'`.execute(ctx.trx);
  for (const r of rows)
    out.set(r.athlete_id, { athleteId: r.athlete_id, slug: r.slug, displayName: r.display_name });
  return out;
}

async function teamName(ctx: TxContext, teamId: string): Promise<string | undefined> {
  const { rows } = await sql<{ team_name: string | null }>`
    SELECT team_name FROM competition_read.event_entry WHERE team_id = ${teamId} AND team_name IS NOT NULL LIMIT 1`.execute(
    ctx.trx,
  );
  return rows[0]?.team_name ?? undefined;
}

const holdingOf = (r: Pick<MarkCardRow, 'status' | 'is_current' | 'ever_held'>) =>
  r.is_current ? 'CURRENT' : r.status === 'SUPERSEDED' && r.ever_held ? 'FORMER' : 'NOT_A_RECORD';

async function toPublic(ctx: TxContext, r: MarkCardRow): Promise<PublicRecordMarkV1> {
  const refs = await athleteRefs(ctx, [
    ...(r.holder_type === 'ATHLETE' ? [r.holder_id] : []),
    ...r.member_athlete_ids,
  ]);
  const name = r.holder_type === 'TEAM' ? await teamName(ctx, r.holder_id) : undefined;
  const standing =
    r.standing === 'CANONICAL'
      ? 'CANONICAL'
      : r.standing === 'RATIFIED'
        ? 'RATIFIED'
        : 'NOT_RATIFIED';
  return {
    schema: 'br:public-record-mark@1',
    recordMarkId: r.record_mark_id,
    recordLabel: r.record_label,
    category: {
      code: r.category_code,
      name: r.category_name,
      version: r.category_version,
      scopeType: r.scope_type,
    },
    metric: r.mark_metric_id,
    value: { ...r.value, display: `${r.value.value} ${r.value.unit}` },
    holder:
      r.holder_type === 'ATHLETE'
        ? { holderType: 'ATHLETE', athlete: refs.get(r.holder_id) ?? { privateEntrant: true } }
        : {
            holderType: 'TEAM',
            team: { teamId: r.holder_id, ...(name === undefined ? {} : { name }) },
          },
    ...(r.holder_type === 'TEAM'
      ? {
          memberCredits: r.member_athlete_ids.map((id) => ({
            creditType: 'TEAM_MEMBER' as const,
            athlete: refs.get(id) ?? { privateEntrant: true },
          })),
        }
      : {}),
    effectiveFrom: r.effective_from.toISOString(),
    ...(r.effective_to === null ? {} : { effectiveTo: r.effective_to.toISOString() }),
    holding: holdingOf(r),
    status: r.status,
    statusLabel: recordStatusLabel(r.status),
    statusStatement: recordStatusStatement(r.status),
    statusReasons: r.status_reasons.map((code) => ({
      code,
      explanation: publicRecordReason(code),
    })),
    recognition: {
      level: r.recognition_level,
      ...(r.region === null ? {} : { region: r.region }),
      ...(r.sport_code === null ? {} : { sport: r.sport_code }),
      ...(r.discipline_code === null ? {} : { discipline: r.discipline_code }),
    },
    verification: {
      basisLevelAtEstablishment: r.basis_level,
      ...(r.ratification_level === null ? {} : { levelAtRatification: r.ratification_level }),
      statement: `Established from a ${r.basis_level} ${VERIFICATION_LEVEL_LABEL[r.basis_level]} result.`,
    },
    ratification: {
      state: standing,
      ...(r.ratified_at === null ? {} : { ratifiedAt: r.ratified_at.toISOString() }),
      statement:
        standing === 'NOT_RATIFIED'
          ? 'Not ratified by a recognizing authority.'
          : standing === 'CANONICAL'
            ? 'Ratified by the designated canonical keeper of this record universe.'
            : 'Ratified by an authority recognized for this record scope.',
    },
    ...(r.record_set_achievement_id === null
      ? {}
      : { recordSetAchievementId: r.record_set_achievement_id }),
    ...(r.superseded_by_mark_id === null ? {} : { supersededByMarkId: r.superseded_by_mark_id }),
    competition: {
      competitionId: r.competition_id,
      ...(r.competition_name === null ? {} : { name: r.competition_name }),
    },
    notice: PUBLIC_RECORD_NOTICE,
  };
}

/** Opaque cursor over a deterministic sort key (never SQL, never a filter language). */
export const encodeCursor = (key: string) => Buffer.from(key, 'utf8').toString('base64url');
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) return undefined;
  const k = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^[\x20-\x7e]{1,300}$/.test(k) ? k : undefined;
}

export interface HallOfFameFilters {
  readonly sport?: string;
  readonly discipline?: string;
  readonly scopeType?: string;
  readonly region?: string;
  readonly category?: string;
  readonly holding?: 'CURRENT' | 'FORMER';
  readonly cursor?: string;
  readonly limit?: number;
}

export class RecordPublicReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private read<T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> {
    return inTransaction(this.db, ModuleRole.publicRead, fn);
  }

  /** Public RecordMark detail; current marks carry LIVE current support (never a stale "current"). */
  async record(recordMarkId: string): Promise<PublicRecordMarkV1 | undefined> {
    if (!UUID.test(recordMarkId)) return undefined;
    const dto = await this.read(async (ctx) => {
      const { rows } = await sql<MarkCardRow>`
        SELECT * FROM (${MARK_SELECT}) x WHERE x.record_mark_id = ${recordMarkId}::uuid`.execute(
        ctx.trx,
      );
      return rows[0] === undefined ? undefined : toPublic(ctx, rows[0]);
    });
    if (dto === undefined || dto.holding !== 'CURRENT') return dto;
    const live = await liveRecordSupport(this.db, recordMarkId);
    if (live === undefined) return dto;
    return {
      ...dto,
      currentSupport: {
        support: live.support,
        statement: recordSupportStatement(live.support),
        reasons: live.reasons.map((code) => ({ code, explanation: publicRecordReason(code) })),
      },
    };
  }

  private async categoryRow(ctx: TxContext, idOrCode: string) {
    const byId = UUID.test(idOrCode);
    if (!byId && !CODE.test(idOrCode)) return undefined;
    const { rows } = await sql<{
      category_id: string;
      code: string;
      name: string;
      scope_type: string;
      version: number;
      lifecycle: string;
      display_name: string;
      sport_code: string | null;
      discipline_code: string | null;
      mark_metric_id: string;
      comparator: string | null;
      tie_policy: string;
      region: string[] | null;
      recognition_level: string;
      minimum_verification_level: string;
      platform_review: boolean;
      canonical_keeper: boolean;
      population: unknown;
      conditions: unknown;
      effective_from: Date;
      current_mark_ids: string[];
    }>`
      SELECT * FROM record_read.category_card
      WHERE ${byId ? sql`category_id = ${idOrCode}::uuid` : sql`code = ${idOrCode}`}
        AND lifecycle <> 'DRAFT'`.execute(ctx.trx);
    return rows[0];
  }

  /** Public category: its universe + recognition policy (no keeper principal, no authority topology). */
  category(idOrCode: string) {
    return this.read(async (ctx) => {
      const c = await this.categoryRow(ctx, idOrCode);
      if (c === undefined) return undefined;
      return {
        schema: 'br:public-record-category@1' as const,
        categoryId: c.category_id,
        code: c.code,
        name: c.name,
        displayName: c.display_name,
        scopeType: c.scope_type,
        version: c.version,
        lifecycle: c.lifecycle,
        metric: c.mark_metric_id,
        ...(c.comparator === null ? {} : { comparator: c.comparator }),
        tiePolicy: c.tie_policy,
        ...(c.sport_code === null ? {} : { sport: c.sport_code }),
        ...(c.discipline_code === null ? {} : { discipline: c.discipline_code }),
        ...(c.region === null ? {} : { region: c.region }),
        recognitionLevel: c.recognition_level,
        minimumVerificationLevel: c.minimum_verification_level,
        platformReview: c.platform_review,
        canonicalKeeperDesignated: c.canonical_keeper,
        population: c.population,
        conditions: c.conditions,
        effectiveFrom: c.effective_from.toISOString(),
        notice: PUBLIC_RECORD_NOTICE,
      };
    });
  }

  /** The current record of a category (SHARED ⇒ every co-holder; never a pending claim). */
  async current(idOrCode: string) {
    const r = await this.read(async (ctx) => {
      const c = await this.categoryRow(ctx, idOrCode);
      if (c === undefined) return undefined;
      const { rows } = await sql<MarkCardRow>`
        SELECT * FROM (${MARK_SELECT}) x WHERE x.category_id = ${c.category_id}::uuid AND x.is_current
        ORDER BY x.effective_from, x.record_mark_id`.execute(ctx.trx);
      return { c, rows };
    });
    if (r === undefined) return undefined;
    const holders: PublicRecordMarkV1[] = [];
    for (const row of r.rows) {
      const dto = await this.record(row.record_mark_id);
      if (dto !== undefined) holders.push(dto);
    }
    return {
      schema: 'br:public-current-record@1' as const,
      category: { code: r.c.code, name: r.c.name, scopeType: r.c.scope_type },
      tiePolicy: r.c.tie_policy,
      current: holders,
      status: holders.length === 0 ? 'NO_CURRENT_RECORD' : 'CURRENT',
      notice: PUBLIC_RECORD_NOTICE,
    };
  }

  /**
   * Full chronology of a category (audit history): current, former, and — explicitly labelled —
   * pending claims and rescinded marks. Cursor-paginated by (effectiveFrom, id).
   */
  history(idOrCode: string, opts: { cursor?: string; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), MAX_PAGE);
    const after = decodeCursor(opts.cursor);
    return this.read(async (ctx) => {
      const c = await this.categoryRow(ctx, idOrCode);
      if (c === undefined) return undefined;
      const { rows } = await sql<MarkCardRow & { k: string }>`
        SELECT * FROM (SELECT x.*, to_char(x.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' || x.record_mark_id AS k
                       FROM (${MARK_SELECT}) x WHERE x.category_id = ${c.category_id}::uuid) y
        WHERE (${after ?? null}::text IS NULL OR y.k > ${after ?? null}::text)
        ORDER BY y.k LIMIT ${limit + 1}`.execute(ctx.trx);
      const page = rows.slice(0, limit);
      const items = [];
      for (const r of page) items.push(await toPublic(ctx, r));
      const last = page[page.length - 1];
      return {
        schema: 'br:public-record-history@1' as const,
        category: { code: c.code, name: c.name, scopeType: c.scope_type },
        items,
        ...(rows.length > limit && last !== undefined ? { nextCursor: encodeCursor(last.k) } : {}),
      };
    });
  }

  /**
   * RECORD HALL OF FAME: legitimate current and former record holders of non-PERSONAL categories.
   * Bounded filters only (no filter language). PENDING and RESCINDED marks never appear; SHARED
   * co-holders all appear for the same value / period.
   */
  hallOfFame(f: HallOfFameFilters = {}) {
    const limit = Math.min(Math.max(f.limit ?? 20, 1), MAX_PAGE);
    const after = decodeCursor(f.cursor);
    const scope =
      f.scopeType !== undefined && (RECORD_SCOPE_TYPES as readonly string[]).includes(f.scopeType)
        ? f.scopeType
        : undefined;
    return this.read(async (ctx) => {
      const { rows } = await sql<{
        record_mark_id: string;
        category_code: string;
        scope_type: string;
        record_label: string;
        holder_type: 'ATHLETE' | 'TEAM';
        holder_id: string;
        member_athlete_ids: string[];
        value: Mark;
        effective_from: Date;
        effective_to: Date | null;
        holding: 'CURRENT' | 'FORMER';
        status: string;
        sport_code: string | null;
        discipline_code: string | null;
        region: string[] | null;
        recognition_level: string;
        sort_key: string;
        record_set_achievement_id: string | null;
      }>`
        SELECT h.*, l.record_set_achievement_id FROM record_read.hall_of_fame_entry h
        LEFT JOIN record_read.v_record_set_link l ON l.record_mark_id = h.record_mark_id
        WHERE h.provenance = 'CANONICAL_ASSEMBLY'
          AND (${f.sport ?? null}::text IS NULL OR h.sport_code = ${f.sport ?? null}::text)
          AND (${f.discipline ?? null}::text IS NULL OR h.discipline_code = ${f.discipline ?? null}::text)
          AND (${scope ?? null}::text IS NULL OR h.scope_type = ${scope ?? null}::text)
          AND (${f.region ?? null}::text IS NULL OR ${f.region ?? null}::text = ANY(h.region))
          AND (${f.category ?? null}::text IS NULL OR h.category_code = ${f.category ?? null}::text)
          AND (${f.holding ?? null}::text IS NULL OR h.holding = ${f.holding ?? null}::text)
          AND (${after ?? null}::text IS NULL OR h.sort_key > ${after ?? null}::text)
        ORDER BY h.sort_key LIMIT ${limit + 1}`.execute(ctx.trx);
      const page = rows.slice(0, limit);
      const refs = await athleteRefs(ctx, [
        ...page.filter((r) => r.holder_type === 'ATHLETE').map((r) => r.holder_id),
        ...page.flatMap((r) => r.member_athlete_ids),
      ]);
      const items = [];
      for (const r of page) {
        const name = r.holder_type === 'TEAM' ? await teamName(ctx, r.holder_id) : undefined;
        items.push({
          recordMarkId: r.record_mark_id,
          categoryCode: r.category_code,
          scopeType: r.scope_type,
          recordLabel: r.record_label,
          holding: r.holding,
          status: r.status,
          holder:
            r.holder_type === 'ATHLETE'
              ? {
                  holderType: 'ATHLETE' as const,
                  athlete: refs.get(r.holder_id) ?? { privateEntrant: true as const },
                }
              : {
                  holderType: 'TEAM' as const,
                  team: { teamId: r.holder_id, ...(name === undefined ? {} : { name }) },
                },
          value: { ...r.value, display: `${r.value.value} ${r.value.unit}` },
          effectiveFrom: r.effective_from.toISOString(),
          ...(r.effective_to === null ? {} : { effectiveTo: r.effective_to.toISOString() }),
          recognition: {
            level: r.recognition_level,
            ...(r.region === null ? {} : { region: r.region }),
            ...(r.sport_code === null ? {} : { sport: r.sport_code }),
          },
          ...(r.record_set_achievement_id === null
            ? {}
            : { recordSetAchievementId: r.record_set_achievement_id }),
        });
      }
      const last = page[page.length - 1];
      return {
        schema: 'br:public-record-hall-of-fame@1' as const,
        items,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: encodeCursor(last.sort_key) }
          : {}),
        notice: HALL_OF_FAME_NOTICE,
      };
    });
  }
}

/** Passport Records section rows for one athlete (read model only — no evaluation here). */
export async function passportRecords(ctx: TxContext, athleteId: string) {
  const { rows } = await sql<MarkCardRow & { credit_type: 'HOLDER' | 'TEAM_MEMBER' }>`
    SELECT x.*, ar.credit_type FROM (${MARK_SELECT}) x
    JOIN record_read.athlete_record ar ON ar.record_mark_id = x.record_mark_id
    WHERE ar.athlete_id = ${athleteId}::uuid
      AND (x.is_current OR (x.status = 'SUPERSEDED' AND x.ever_held))
    ORDER BY x.is_current DESC, x.effective_from DESC, x.record_mark_id`.execute(ctx.trx);
  return rows.map((r) => ({
    recordMarkId: r.record_mark_id,
    categoryCode: r.category_code,
    recordLabel: r.record_label,
    scopeType: r.scope_type,
    holding: (r.is_current ? 'CURRENT' : 'FORMER') as 'CURRENT' | 'FORMER',
    status: r.status as 'RATIFIED' | 'CANONICAL' | 'SUPERSEDED',
    creditType: r.credit_type,
    holderType: r.holder_type,
    value: `${r.value.value} ${r.value.unit}`,
    effectiveFrom: r.effective_from.toISOString(),
    ...(r.effective_to === null ? {} : { effectiveTo: r.effective_to.toISOString() }),
    ...(r.sport_code === null ? {} : { sport: r.sport_code }),
    ...(r.discipline_code === null ? {} : { discipline: r.discipline_code }),
    ...(r.record_set_achievement_id === null
      ? {}
      : { recordSetAchievementId: r.record_set_achievement_id }),
  }));
}
