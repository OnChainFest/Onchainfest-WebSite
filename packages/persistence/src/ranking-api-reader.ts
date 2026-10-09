import { serializeJcs, type CanonicalValue } from '@br/canonical';
import { DomainError, DomainErrorCode, type HolderType, type Mark, type Uuid } from '@br/domain';
import {
  PUBLIC_CLASSIFICATION_STATUSES,
  STAFF_CLASSIFICATION_PROPOSAL_SCHEMA,
  publicClassification,
  publicClassificationEntries,
  publicLeaderboard,
  publicRankingSnapshot,
  publicRankingSystem,
  publicRankingSystemList,
  publicSnapshotHistory,
  rankingSystemLabel,
  staffRankingRun,
  validateRankingSnapshot,
  type ClassificationCardFacts,
  type ClassificationStaleness,
  type PublicClassificationEntriesV1,
  type PublicClassificationStatus,
  type PublicClassificationV1,
  type PublicEntrantDisplay,
  type PublicRankingLeaderboardV1,
  type PublicRankingSnapshotHistoryV1,
  type PublicRankingSnapshotV1,
  type PublicRankingSystemListV1,
  type PublicRankingSystemV1,
  type PublicTraceItem,
  type RankingSnapshotContent,
  type RankingSystemCardFacts,
  type SnapshotCardFacts,
  type StaffRankingRunV1,
} from '@br/rankings';
import { sql } from 'kysely';
import { readClassificationIn } from './classification-staleness';
import type { Db } from './db';
import {
  competitionPermissionSet,
  resolveResultVersion,
  resultVersionPath,
  type EvidenceActor,
} from './evidence-support';
import { snapshotStalenessIn } from './ranking-history';
import { snapshotHistory, type SnapshotCardRow, type SnapshotView } from './ranking-read-model';
import { proposeClassificationIn } from './result-ledger';
import { inTransaction, ModuleRole, withModuleRole, type TxContext } from './tx';

/**
 * BRT-10 Step 11 — the /v1 read surface over the Step 8 projections, composed with the Step 7 readers
 * (ADR-0048 §8–9, ADR-0047 §5). Writes nothing.
 *
 *   public (br_public_read)        system cards, snapshot history, snapshot + leaderboard, classification
 *                                  card + ranked rows. Canonical provenance only; classifications only
 *                                  while their latest status is PROVISIONAL / OFFICIAL / FINAL; `@1`
 *                                  classifications have no card (404).
 *   read-time staleness            composed in the SAME repeatable-read transaction from the existing Step 7
 *                                  functions: snapshotStalenessIn under br_achievements (+ the SELECT-only
 *                                  br_verification_reader) and readClassificationIn under br_results — the
 *                                  roles the API login already holds (0027 / 0023). Never stored.
 *   projection drift               every projection row served for a snapshot / leaderboard / classification
 *                                  is compared with the canonical fact read in the same snapshot; a
 *                                  difference is RANKING_INTEGRITY_FAILURE (PROJECTION_MISMATCH), never
 *                                  silently served.
 *   staff (br_ranking_staff_reader) the run card + every candidate (0030; SELECT-only on run projections).
 *   COMP_STAFF                     the read-only classification proposal, after the competition-staff
 *                                  check (COMP_VIEW_PRIVATE on the version's competition, from database
 *                                  facts; denial = NOT_FOUND).
 *
 * Nothing here ranks, re-ranks, re-derives a stored ranking, writes a run / snapshot / classification /
 * Achievement or computes a second staleness.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9][a-z0-9-]{1,63}$/;
export const RANKING_MAX_PAGE = 50;
const DEFAULT_PAGE = 20;

const notFound = (what: string) => new DomainError(DomainErrorCode.NOT_FOUND, `${what} not found`);
const drift = () =>
  new DomainError(
    DomainErrorCode.RANKING_INTEGRITY_FAILURE,
    'ranking projection does not match the canonical facts',
    { reason: 'PROJECTION_MISMATCH' },
  );
const same = (a: unknown, b: unknown) =>
  serializeJcs(a as CanonicalValue) === serializeJcs(b as CanonicalValue);
const iso = (d: Date) => d.toISOString();

// ───────────────────────────── cursors (BRT-10: an undecodable cursor is a 400) ─────────────────────────────

export const encodeRankingCursor = (key: string) => Buffer.from(key, 'utf8').toString('base64url');

/** Strict: a cursor that is not exactly the encoding of a key of `shape` is INVALID_INPUT. */
export function decodeRankingCursor(cursor: string | undefined, shape: RegExp): string | undefined {
  if (cursor === undefined) return undefined;
  const invalid = () => new DomainError(DomainErrorCode.INVALID_INPUT, 'invalid cursor');
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(cursor)) throw invalid();
  const key = Buffer.from(cursor, 'base64url').toString('utf8');
  if (encodeRankingCursor(key) !== cursor || !shape.test(key)) throw invalid();
  return key;
}

const pageSize = (limit: number | undefined) =>
  Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), RANKING_MAX_PAGE);

const SYSTEM_CURSOR = CODE;
const POSITION_CURSOR = /^[1-9][0-9]{0,8}$/;
const LEADERBOARD_CURSOR =
  /^([1-9][0-9]{0,8})\|(ATHLETE|TEAM)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const ENTRY_CURSOR =
  /^([1-9][0-9]{0,8})\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface PageOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

// ───────────────────────────── rows ─────────────────────────────

interface SystemCardRow {
  system_id: string;
  code: string;
  name: string;
  kind: 'PLATFORM' | 'OFFICIAL';
  label: string | null;
  latest_version: number;
  latest_lifecycle: 'PUBLISHED' | 'RETIRED';
  latest_spec_hash: string;
  published_version: number | null;
  display_name: string;
  method: string;
  discipline_version_id: string;
  metric_key: string;
  mark_metric_id: string;
  holder_type: HolderType;
  recognition_level: string;
  minimum_verification_level: string;
  effective_from: Date;
}

/** ADR-0048 §7: the stored label must be exactly the computed one (PLATFORM) or absent (OFFICIAL). */
function systemFacts(r: SystemCardRow): RankingSystemCardFacts {
  if ((rankingSystemLabel(r.kind) ?? null) !== r.label) throw drift();
  return {
    systemId: r.system_id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    latestVersion: r.latest_version,
    latestLifecycle: r.latest_lifecycle,
    latestSpecHash: r.latest_spec_hash,
    ...(r.published_version === null ? {} : { publishedVersion: r.published_version }),
    displayName: r.display_name,
    method: r.method,
    disciplineVersionId: r.discipline_version_id,
    metricKey: r.metric_key,
    markMetricId: r.mark_metric_id,
    holderType: r.holder_type,
    recognitionLevel: r.recognition_level,
    minimumVerificationLevel: r.minimum_verification_level,
    effectiveFrom: iso(r.effective_from),
  };
}

type SnapshotCard = SnapshotCardRow & { system_code: string | null };

function snapshotFacts(
  c: SnapshotCard,
  extra: { readonly corrects?: readonly string[] } = {},
): SnapshotCardFacts {
  if (c.system_code === null) throw drift();
  return {
    snapshotId: c.snapshot_id,
    snapshotHash: c.snapshot_hash,
    systemId: c.system_id,
    systemCode: c.system_code,
    systemVersionId: c.system_version_id,
    systemVersion: c.system_version,
    specHash: c.spec_hash,
    kind: c.kind as 'PLATFORM' | 'OFFICIAL',
    method: c.method,
    engineVersion: c.engine_version,
    asOf: iso(c.as_of),
    publishedAt: iso(c.published_at),
    lineageKind: c.lineage_kind,
    ...(c.prior_snapshot_id === null ? {} : { priorSnapshotId: c.prior_snapshot_id }),
    ...(c.prior_snapshot_hash === null ? {} : { priorSnapshotHash: c.prior_snapshot_hash }),
    lineageReasons: c.lineage_reasons,
    chainPosition: c.chain_position,
    ...(c.corrected_by_snapshot_id === null
      ? {}
      : { correctedBySnapshotId: c.corrected_by_snapshot_id }),
    entryCount: c.entry_count,
    ...extra,
  };
}

interface ClassificationCardRow {
  classification_version_id: string;
  result_id: string;
  scope_type: ClassificationCardFacts['scopeType'];
  scope_target_id: string;
  version_number: number;
  content_schema: string;
  content_hash: string;
  policy_id: string;
  policy_version_id: string;
  policy_spec_hash: string;
  discipline_version_id: string;
  engine_version: string;
  inputs_digest: string;
  input_count: number;
  status: string;
  status_since: Date;
  submitted_at: Date;
}

interface ClassificationContentEntry {
  readonly participantId: string;
  readonly rank: number;
  readonly tied: boolean;
  readonly tieBreakKeys: readonly PublicTraceItem[];
}

const isPublicStatus = (s: string): s is PublicClassificationStatus =>
  (PUBLIC_CLASSIFICATION_STATUSES as readonly string[]).includes(s);

// ───────────────────────────── display (Passport privacy policy) ─────────────────────────────

/** Athletes are named only when their Passport card is ACTIVE, PUBLIC and not restricted. */
async function holderDisplays(
  ctx: TxContext,
  holders: readonly { readonly holderType: HolderType; readonly holderId: string }[],
): Promise<Map<string, PublicEntrantDisplay>> {
  const out = new Map<string, PublicEntrantDisplay>();
  const athletes = holders.filter((h) => h.holderType === 'ATHLETE').map((h) => h.holderId);
  const teams = holders.filter((h) => h.holderType === 'TEAM').map((h) => h.holderId);
  for (const id of athletes) out.set(`ATHLETE|${id}`, { kind: 'PRIVATE_ENTRANT' });
  for (const id of teams) out.set(`TEAM|${id}`, { kind: 'TEAM', teamName: 'Team' });
  if (athletes.length > 0) {
    const { rows } = await sql<{ athlete_id: string; slug: string; display_name: string }>`
      SELECT athlete_id, slug, display_name FROM passport.athlete_card
      WHERE athlete_id = ANY(${athletes}::uuid[]) AND profile_visibility = 'PUBLIC' AND NOT restricted
        AND athlete_status = 'ACTIVE'`.execute(ctx.trx);
    for (const r of rows)
      out.set(`ATHLETE|${r.athlete_id}`, {
        kind: 'ATHLETE',
        athleteSlug: r.slug,
        displayName: r.display_name,
      });
  }
  if (teams.length > 0) {
    const { rows } = await sql<{ team_id: string; team_name: string }>`
      SELECT DISTINCT ON (team_id) team_id, team_name FROM competition_read.event_entry
      WHERE team_id = ANY(${teams}::uuid[]) AND team_name IS NOT NULL
      ORDER BY team_id, team_name`.execute(ctx.trx);
    for (const r of rows) out.set(`TEAM|${r.team_id}`, { kind: 'TEAM', teamName: r.team_name });
  }
  return out;
}

/** Competition participants (BRT-05 public entrant display). */
async function participantDisplays(
  ctx: TxContext,
  participantIds: readonly string[],
): Promise<Map<string, PublicEntrantDisplay>> {
  const out = new Map<string, PublicEntrantDisplay>(
    participantIds.map((id) => [id, { kind: 'PRIVATE_ENTRANT' }]),
  );
  if (participantIds.length === 0) return out;
  const { rows } = await sql<{
    participant_id: string;
    entrant_type: 'INDIVIDUAL' | 'TEAM';
    team_name: string | null;
    card_slug: string | null;
    card_name: string | null;
    visible: boolean;
  }>`
    SELECT e.participant_id, e.entrant_type, e.team_name, c.slug AS card_slug, c.display_name AS card_name,
           (c.athlete_id IS NOT NULL AND c.athlete_status = 'ACTIVE' AND NOT c.restricted
            AND c.profile_visibility = 'PUBLIC') AS visible
    FROM competition_read.event_entry e LEFT JOIN passport.athlete_card c ON c.athlete_id = e.athlete_id
    WHERE e.participant_id = ANY(${[...participantIds]}::uuid[])`.execute(ctx.trx);
  for (const r of rows)
    out.set(
      r.participant_id,
      r.entrant_type === 'TEAM'
        ? { kind: 'TEAM', teamName: r.team_name ?? 'Team' }
        : r.visible
          ? {
              kind: 'ATHLETE',
              athleteSlug: r.card_slug as string,
              displayName: r.card_name as string,
            }
          : { kind: 'PRIVATE_ENTRANT' },
    );
  return out;
}

// ───────────────────────────── canonical reads (same transaction) ─────────────────────────────

/**
 * The canonical snapshot (under br_achievements, SELECT-only on ranking.* since 0027), its content
 * re-hashed, cross-checked with the projected card.
 */
async function canonicalSnapshot(
  ctx: TxContext,
  card: SnapshotCard,
): Promise<RankingSnapshotContent> {
  const { rows } = await sql<{
    snapshot_hash: string;
    system_id: string;
    system_version_id: string;
    spec_hash: string;
    provenance: string;
    lineage_kind: string;
    previous_snapshot_id: string | null;
    corrects_snapshot_id: string | null;
    entry_count: number;
    as_of: Date;
    recorded_at: Date;
    content: unknown;
  }>`
    SELECT snapshot_hash, system_id::text AS system_id, system_version_id::text AS system_version_id, spec_hash,
           provenance, lineage_kind, previous_snapshot_id::text AS previous_snapshot_id,
           corrects_snapshot_id::text AS corrects_snapshot_id, entry_count, as_of, recorded_at, content
    FROM ranking.snapshot WHERE id = ${card.snapshot_id}`.execute(ctx.trx);
  const s = rows[0];
  if (s === undefined) throw drift();
  const v = validateRankingSnapshot(s.content);
  if (!v.ok || v.hash !== s.snapshot_hash)
    throw new DomainError(
      DomainErrorCode.RANKING_INTEGRITY_FAILURE,
      'stored snapshot content does not match its hash',
      { reason: 'SNAPSHOT_HASH_MISMATCH' },
    );
  const c = v.value;
  if (
    card.snapshot_hash !== s.snapshot_hash ||
    card.system_id !== s.system_id ||
    card.system_version_id !== s.system_version_id ||
    card.spec_hash !== s.spec_hash ||
    card.provenance !== s.provenance ||
    card.lineage_kind !== s.lineage_kind ||
    card.prior_snapshot_id !== (s.previous_snapshot_id ?? s.corrects_snapshot_id) ||
    card.entry_count !== s.entry_count ||
    card.entry_count !== c.entries.length ||
    card.as_of.getTime() !== s.as_of.getTime() ||
    card.published_at.getTime() !== s.recorded_at.getTime() ||
    card.kind !== c.kind ||
    card.method !== c.method ||
    card.engine_version !== c.engineVersion
  )
    throw drift();
  return c;
}

interface LeaderboardRow {
  holder_type: HolderType;
  holder_id: string;
  rank: number;
  tied: boolean;
  value: Mark;
  comparator_trace: PublicTraceItem[];
  basis_count: number;
}

/** Every served leaderboard row must equal its canonical snapshot entry (and nothing may be extra). */
function assertLeaderboard(
  content: RankingSnapshotContent,
  rows: readonly LeaderboardRow[],
  total: number,
) {
  if (total !== content.entries.length) throw drift();
  const byHolder = new Map(
    content.entries.map((e) => [`${e.holder.holderType}|${e.holder.holderId}`, e]),
  );
  for (const r of rows) {
    const e = byHolder.get(`${r.holder_type}|${r.holder_id}`);
    if (
      e === undefined ||
      e.rank !== r.rank ||
      e.tied !== r.tied ||
      e.basis.length !== r.basis_count ||
      !same(e.value, r.value) ||
      !same(e.comparatorTrace, r.comparator_trace)
    )
      throw drift();
  }
}

/** The canonical `@2` classification (under br_results) cross-checked with its projected card. */
async function canonicalClassification(ctx: TxContext, card: ClassificationCardRow) {
  return withModuleRole(ctx, ModuleRole.results, async (rctx) => {
    let read;
    try {
      read = await readClassificationIn(rctx, card.classification_version_id);
    } catch (err) {
      if (err instanceof DomainError && err.code === DomainErrorCode.NOT_FOUND) throw drift();
      throw err;
    }
    const d = read.derivation;
    if (
      d === undefined ||
      read.staleness.state === 'PROVENANCE_UNAVAILABLE' ||
      read.status !== card.status ||
      read.contentHash !== card.content_hash ||
      read.contentSchema !== card.content_schema ||
      read.resultId !== card.result_id ||
      read.scopeType !== card.scope_type ||
      read.scopeTargetId !== card.scope_target_id ||
      d.policy.policyId !== card.policy_id ||
      d.policy.policyVersionId !== card.policy_version_id ||
      d.policy.specHash !== card.policy_spec_hash ||
      d.disciplineVersionId !== card.discipline_version_id ||
      d.engineVersion !== card.engine_version ||
      d.inputsDigest !== card.inputs_digest ||
      d.derivedFrom.length !== card.input_count
    )
      throw drift();
    const { rows } = await sql<{ content: { entries: ClassificationContentEntry[] } }>`
      SELECT content FROM results.result_version WHERE id = ${card.classification_version_id}`.execute(
      rctx.trx,
    );
    const entries = rows[0]?.content.entries;
    if (entries === undefined) throw drift();
    return { staleness: read.staleness as ClassificationStaleness, entries };
  });
}

interface ClassificationEntryRow {
  participant_id: string;
  rank: number;
  tied: boolean;
  tie_break_keys: PublicTraceItem[];
}

function assertClassificationEntries(
  canonical: readonly ClassificationContentEntry[],
  rows: readonly ClassificationEntryRow[],
  total: number,
) {
  if (total !== canonical.length) throw drift();
  const byParticipant = new Map(canonical.map((e) => [e.participantId, e]));
  for (const r of rows) {
    const e = byParticipant.get(r.participant_id);
    if (
      e === undefined ||
      e.rank !== r.rank ||
      e.tied !== r.tied ||
      !same(e.tieBreakKeys, r.tie_break_keys)
    )
      throw drift();
  }
}

// ───────────────────────────── public reader ─────────────────────────────

const SNAPSHOT_CARD_SELECT = sql`
  SELECT c.*, s.code AS system_code FROM ranking_read.snapshot_card c
  LEFT JOIN ranking_read.system_card s ON s.system_id = c.system_id`;

/**
 * Lane token for the TEST HARNESS only (`rankingFixturePublicReader`, exported from
 * `@br/persistence/ranking-lanes`, never from the package root): the same reader over the throwaway
 * br_rkfx_ overlay's REFERENCE_FIXTURE snapshots. Without it, only CANONICAL_ASSEMBLY rows are public.
 */
export const RANKING_FIXTURE_READ_LANE: unique symbol = Symbol('ranking-fixture-read-lane');

export class RankingPublicReader {
  private readonly db: Db;
  private readonly provenance: 'CANONICAL_ASSEMBLY' | 'REFERENCE_FIXTURE';

  constructor(db: Db, lane?: typeof RANKING_FIXTURE_READ_LANE) {
    this.db = db;
    this.provenance =
      lane === RANKING_FIXTURE_READ_LANE ? 'REFERENCE_FIXTURE' : 'CANONICAL_ASSEMBLY';
  }

  /** One consistent snapshot for the projection rows AND the canonical facts they are checked against. */
  private read<T>(fn: (ctx: TxContext) => Promise<T>) {
    return inTransaction(this.db, ModuleRole.publicRead, fn, 4, { isolation: 'repeatable read' });
  }

  private async systemRow(ctx: TxContext, idOrCode: string): Promise<SystemCardRow | undefined> {
    const byId = UUID.test(idOrCode);
    if (!byId && !CODE.test(idOrCode)) return undefined;
    // BRT-09 convention: a card whose latest version is a DRAFT is not public.
    const { rows } = await sql<SystemCardRow>`
      SELECT * FROM ranking_read.system_card
      WHERE ${byId ? sql`system_id = ${idOrCode}::uuid` : sql`code = ${idOrCode}`}
        AND latest_lifecycle <> 'DRAFT'`.execute(ctx.trx);
    return rows[0];
  }

  /** Published (or retired) ranking systems, by code. */
  systems(opts: PageOptions = {}): Promise<PublicRankingSystemListV1> {
    const limit = pageSize(opts.limit);
    const after = decodeRankingCursor(opts.cursor, SYSTEM_CURSOR);
    return this.read(async (ctx) => {
      const { rows } = await sql<SystemCardRow>`
        SELECT * FROM ranking_read.system_card
        WHERE latest_lifecycle <> 'DRAFT' ${after === undefined ? sql`` : sql`AND code > ${after}`}
        ORDER BY code LIMIT ${limit + 1}`.execute(ctx.trx);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return publicRankingSystemList(
        page.map(systemFacts),
        rows.length > limit && last !== undefined ? encodeRankingCursor(last.code) : undefined,
      );
    });
  }

  system(idOrCode: string): Promise<PublicRankingSystemV1 | undefined> {
    return this.read(async (ctx) => {
      const r = await this.systemRow(ctx, idOrCode);
      return r === undefined ? undefined : publicRankingSystem(systemFacts(r));
    });
  }

  /** As-published / as-corrected history (ADR-0048 §8), canonical snapshots only, by chain position. */
  history(
    idOrCode: string,
    view: SnapshotView,
    opts: PageOptions = {},
  ): Promise<PublicRankingSnapshotHistoryV1 | undefined> {
    const limit = pageSize(opts.limit);
    const after = decodeRankingCursor(opts.cursor, POSITION_CURSOR);
    return this.read(async (ctx) => {
      const system = await this.systemRow(ctx, idOrCode);
      if (system === undefined) return undefined;
      const { rows } = await sql<SnapshotCard>`
        ${SNAPSHOT_CARD_SELECT}
        WHERE c.system_id = ${system.system_id} AND c.provenance = ${this.provenance}
        ORDER BY c.chain_position`.execute(ctx.trx);
      const items = snapshotHistory(rows, view) as readonly (SnapshotCard & {
        corrects?: readonly string[];
      })[];
      const rest = items.filter((i) => after === undefined || i.chain_position > Number(after));
      const page = rest.slice(0, limit);
      const last = page.at(-1);
      return publicSnapshotHistory(
        system.system_id,
        view,
        page.map((c) => snapshotFacts(c, c.corrects === undefined ? {} : { corrects: c.corrects })),
        rest.length > limit && last !== undefined
          ? encodeRankingCursor(String(last.chain_position))
          : undefined,
      );
    });
  }

  private async snapshotCard(ctx: TxContext, snapshotId: string) {
    const { rows } = await sql<SnapshotCard>`
      ${SNAPSHOT_CARD_SELECT}
      WHERE c.snapshot_id = ${snapshotId} AND c.provenance = ${this.provenance}`.execute(ctx.trx);
    return rows[0];
  }

  /** Immutable snapshot facts + read-time staleness (Step 7 `snapshotStalenessIn`, never stored). */
  snapshot(snapshotId: string): Promise<PublicRankingSnapshotV1 | undefined> {
    return this.read(async (ctx) => {
      const card = await this.snapshotCard(ctx, snapshotId);
      if (card === undefined) return undefined;
      const staleness = await withModuleRole(ctx, ModuleRole.achievements, async (actx) =>
        snapshotStalenessIn(actx, await canonicalSnapshot(actx, card)),
      );
      return publicRankingSnapshot(snapshotFacts(card), staleness);
    });
  }

  /** Canonical rank order (rank, then a meaningless set order inside a tie); no basis topology. */
  leaderboard(
    snapshotId: string,
    opts: PageOptions = {},
  ): Promise<PublicRankingLeaderboardV1 | undefined> {
    const limit = pageSize(opts.limit);
    const key = decodeRankingCursor(opts.cursor, LEADERBOARD_CURSOR);
    const after = key === undefined ? undefined : LEADERBOARD_CURSOR.exec(key);
    return this.read(async (ctx) => {
      const card = await this.snapshotCard(ctx, snapshotId);
      if (card === undefined) return undefined;
      const { rows } = await sql<LeaderboardRow>`
        SELECT holder_type, holder_id::text AS holder_id, rank, tied, value, comparator_trace, basis_count
        FROM ranking_read.leaderboard_entry WHERE snapshot_id = ${snapshotId}
        ${
          after === undefined || after === null
            ? sql``
            : sql`AND (rank, holder_type, holder_id) > (${Number(after[1])}, ${after[2]}, ${after[3]}::uuid)`
        }
        ORDER BY rank, holder_type, holder_id LIMIT ${limit + 1}`.execute(ctx.trx);
      const { rows: count } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ranking_read.leaderboard_entry WHERE snapshot_id = ${snapshotId}`.execute(
        ctx.trx,
      );
      const page = rows.slice(0, limit);
      await withModuleRole(ctx, ModuleRole.achievements, async (actx) =>
        assertLeaderboard(await canonicalSnapshot(actx, card), page, count[0]?.n ?? -1),
      );
      const displays = await holderDisplays(
        ctx,
        page.map((r) => ({ holderType: r.holder_type, holderId: r.holder_id })),
      );
      const last = page.at(-1);
      return publicLeaderboard(
        card.snapshot_id,
        card.snapshot_hash,
        page.map((r) => ({
          holderType: r.holder_type,
          holderId: r.holder_id,
          rank: r.rank,
          tied: r.tied,
          value: r.value,
          comparatorTrace: r.comparator_trace,
          basisCount: r.basis_count,
          display: displays.get(`${r.holder_type}|${r.holder_id}`) ?? { kind: 'PRIVATE_ENTRANT' },
        })),
        rows.length > limit && last !== undefined
          ? encodeRankingCursor(`${last.rank}|${last.holder_type}|${last.holder_id}`)
          : undefined,
      );
    });
  }

  /** The public `@2` card, live statuses only; undefined (404) for anything else. */
  private async classificationCard(ctx: TxContext, resultVersionId: string) {
    const { rows } = await sql<ClassificationCardRow>`
      SELECT * FROM ranking_read.classification_card
      WHERE classification_version_id = ${resultVersionId}`.execute(ctx.trx);
    const card = rows[0];
    return card === undefined || !isPublicStatus(card.status) ? undefined : card;
  }

  /** The `@2` classification card + read-time staleness under its PINNED policy (Step 7). */
  classification(resultVersionId: string): Promise<PublicClassificationV1 | undefined> {
    return this.read(async (ctx) => {
      const card = await this.classificationCard(ctx, resultVersionId);
      if (card === undefined) return undefined;
      const canonical = await canonicalClassification(ctx, card);
      const { rows: count } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ranking_read.classification_entry
        WHERE classification_version_id = ${resultVersionId}`.execute(ctx.trx);
      if (count[0]?.n !== canonical.entries.length) throw drift();
      return publicClassification(
        {
          resultVersionId: card.classification_version_id,
          resultId: card.result_id,
          scopeType: card.scope_type,
          scopeTargetId: card.scope_target_id,
          versionNumber: card.version_number,
          contentHash: card.content_hash,
          policyId: card.policy_id,
          policyVersionId: card.policy_version_id,
          policySpecHash: card.policy_spec_hash,
          disciplineVersionId: card.discipline_version_id,
          engineVersion: card.engine_version,
          inputsDigest: card.inputs_digest,
          inputCount: card.input_count,
          status: card.status as PublicClassificationStatus,
          statusSince: iso(card.status_since),
          submittedAt: iso(card.submitted_at),
          entryCount: canonical.entries.length,
        },
        canonical.staleness,
      );
    });
  }

  /** The ranked rows, copied from the immutable content (never re-ranked), by (rank, participant). */
  classificationEntries(
    resultVersionId: string,
    opts: PageOptions = {},
  ): Promise<PublicClassificationEntriesV1 | undefined> {
    const limit = pageSize(opts.limit);
    const key = decodeRankingCursor(opts.cursor, ENTRY_CURSOR);
    const after = key === undefined ? undefined : ENTRY_CURSOR.exec(key);
    return this.read(async (ctx) => {
      const card = await this.classificationCard(ctx, resultVersionId);
      if (card === undefined) return undefined;
      const canonical = await canonicalClassification(ctx, card);
      const { rows } = await sql<ClassificationEntryRow>`
        SELECT participant_id::text AS participant_id, rank, tied, tie_break_keys
        FROM ranking_read.classification_entry WHERE classification_version_id = ${resultVersionId}
        ${
          after === undefined || after === null
            ? sql``
            : sql`AND (rank, participant_id) > (${Number(after[1])}, ${after[2]}::uuid)`
        }
        ORDER BY rank, participant_id LIMIT ${limit + 1}`.execute(ctx.trx);
      const { rows: count } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ranking_read.classification_entry
        WHERE classification_version_id = ${resultVersionId}`.execute(ctx.trx);
      const page = rows.slice(0, limit);
      assertClassificationEntries(canonical.entries, page, count[0]?.n ?? -1);
      const displays = await participantDisplays(
        ctx,
        page.map((r) => r.participant_id),
      );
      const last = page.at(-1);
      return publicClassificationEntries(
        card.classification_version_id,
        card.content_hash,
        page.map((r) => ({
          participantId: r.participant_id,
          rank: r.rank,
          tied: r.tied,
          tieBreakKeys: r.tie_break_keys,
          display: displays.get(r.participant_id) ?? { kind: 'PRIVATE_ENTRANT' },
        })),
        rows.length > limit && last !== undefined
          ? encodeRankingCursor(`${last.rank}|${last.participant_id}`)
          : undefined,
      );
    });
  }
}

// ───────────────────────────── staff ─────────────────────────────

export class RankingStaffReader {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  /**
   * INTERNAL: a run card + every candidate with state and blockers, through the SELECT-only
   * br_ranking_staff_reader (0030) — never br_rankings. Diagnostic only: nothing is evaluated,
   * published, re-ranked or written.
   */
  run(runId: string): Promise<StaffRankingRunV1 | undefined> {
    if (!UUID.test(runId)) return Promise.resolve(undefined);
    // A plain transaction (not inTransaction): the reader role holds SELECT on the two run projections
    // and NOTHING else — not even platform.tx_time_ms(), which this read does not need.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        await sql`SET LOCAL ROLE ${sql.id(ModuleRole.rankingStaffReader)}`.execute(trx);
        const { rows } = await sql<{
          run_id: string;
          system_id: string;
          system_version_id: string;
          system_version: number;
          spec_hash: string;
          engine_version: string;
          provenance: string;
          input_hash: string;
          outcome_hash: string;
          as_of: Date;
          publication_state: 'PUBLISHABLE' | 'BLOCKED';
          publication_reasons: string[];
          entry_count: number;
          candidate_count: number;
          trigger: string;
          recorded_at: Date;
        }>`SELECT * FROM ranking_read.run_card WHERE run_id = ${runId}`.execute(trx);
        const c = rows[0];
        if (c === undefined) return undefined;
        const { rows: candidates } = await sql<{
          result_version_id: string;
          participant_id: string;
          ordinal: number;
          state: string;
          reasons: string[];
        }>`
          SELECT result_version_id::text AS result_version_id, participant_id::text AS participant_id, ordinal,
                 state, reasons
          FROM ranking_read.run_candidate WHERE run_id = ${runId}
          ORDER BY result_version_id, participant_id, ordinal`.execute(trx);
        return staffRankingRun(
          {
            runId: c.run_id,
            systemId: c.system_id,
            systemVersionId: c.system_version_id,
            systemVersion: c.system_version,
            specHash: c.spec_hash,
            engineVersion: c.engine_version,
            provenance: c.provenance,
            inputHash: c.input_hash,
            outcomeHash: c.outcome_hash,
            asOf: iso(c.as_of),
            publicationState: c.publication_state,
            publicationReasons: c.publication_reasons,
            entryCount: c.entry_count,
            candidateCount: c.candidate_count,
            trigger: c.trigger,
            recordedAt: iso(c.recorded_at),
          },
          candidates.map((x) => ({
            resultVersionId: x.result_version_id,
            participantId: x.participant_id,
            ordinal: x.ordinal,
            state: x.state,
            reasons: x.reasons,
          })),
        );
      });
  }

  /**
   * COMP_STAFF: the read-only canonical classification proposal for the Result of an exact
   * ResultVersion (ADR-0047 §3 step 1). Authorization first, from database facts (the version's own
   * competition path, COMP_VIEW_PRIVATE — the BRT-07/08/09 staff rule), read through the SELECT-only
   * br_verification_reader; an unknown version and a denial are the same NOT_FOUND. Nothing is
   * supplied by the caller and nothing is written: no draft, version, event or audit row.
   */
  async proposeClassification(input: {
    readonly actor: EvidenceActor;
    readonly resultVersionId: string;
  }) {
    if (!UUID.test(input.resultVersionId)) throw notFound('result version');
    return inTransaction(
      this.db,
      ModuleRole.results,
      async (ctx) => {
        const rv = await withModuleRole(ctx, ModuleRole.verificationReader, async (vctx) => {
          const v = await resolveResultVersion(vctx, input.resultVersionId);
          if (v === undefined) return undefined;
          if ('internal' in input.actor) return v;
          const path = await resultVersionPath(vctx, v);
          if (path?.competitionId === undefined) return undefined;
          const perms = await competitionPermissionSet(
            vctx,
            input.actor.accountId,
            path.competitionId,
          );
          return perms.has('COMP_VIEW_PRIVATE') ? v : undefined;
        });
        if (rv === undefined) throw notFound('result version');
        const proposal = await proposeClassificationIn(ctx, rv.resultId as Uuid);
        return {
          schema: STAFF_CLASSIFICATION_PROPOSAL_SCHEMA,
          resultVersionId: rv.resultVersionId,
          resultId: rv.resultId,
          ...proposal,
        };
      },
      4,
      { isolation: 'repeatable read' },
    );
  }
}
