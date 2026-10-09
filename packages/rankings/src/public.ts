import { sha256, serializeJcs, toContentHash, type CanonicalValue } from '@br/canonical';
import type { ComparatorOrder } from '@br/competition';
import {
  PLATFORM_RANKING_LABEL,
  type ClassificationStaleReason,
  type HolderType,
  type Mark,
  type RankingSnapshotStaleReason,
} from '@br/domain';
import type { ClassificationStaleness, RankingSnapshotStaleness } from './staleness';

/**
 * BRT-10 Step 11 — pure public / staff DTO composition (ADR-0048 §7–9, ADR-0047 §5). Input: projection
 * facts already read (dates as RFC 3339 strings) + the read-time staleness computed by the Step 7
 * functions. Output: explicit, closed, schema-tagged DTOs. No database, clock, randomness or
 * environment: the same input always gives the byte-identical canonical DTO (API vectors).
 *
 * Public DTOs never carry basis topology (ResultVersion / VerificationRun ids, evidence commitments,
 * hold), the classification derivedFrom pins, the staleness `affected` / `notCurrent` / `added` /
 * `removed` lists, the staleDigest, run ids or hashes, owner / anchor / account ids. Staleness is a
 * `readTime` block, separate from the immutable stored facts, and is never stored anywhere.
 * Nothing is re-ranked or recomputed: ranks, ties, values and traces are copied.
 */

export const PUBLIC_RANKING_SYSTEM_SCHEMA = 'br:public-ranking-system@1';
export const PUBLIC_RANKING_SYSTEM_LIST_SCHEMA = 'br:public-ranking-system-list@1';
export const PUBLIC_RANKING_SNAPSHOT_HISTORY_SCHEMA = 'br:public-ranking-snapshot-history@1';
export const PUBLIC_RANKING_SNAPSHOT_SCHEMA = 'br:public-ranking-snapshot@1';
export const PUBLIC_RANKING_LEADERBOARD_SCHEMA = 'br:public-ranking-leaderboard@1';
export const PUBLIC_CLASSIFICATION_SCHEMA = 'br:public-classification@1';
export const PUBLIC_CLASSIFICATION_ENTRIES_SCHEMA = 'br:public-classification-entries@1';
export const STAFF_RANKING_RUN_SCHEMA = 'br:staff-ranking-run@1';
export const STAFF_CLASSIFICATION_PROPOSAL_SCHEMA = 'br:staff-classification-proposal@1';

/** ADR-0047 §5: only live versions are public; SUBMITTED / REJECTED / REVOKED / SUPERSEDED are not. */
export const PUBLIC_CLASSIFICATION_STATUSES = ['PROVISIONAL', 'OFFICIAL', 'FINAL'] as const;
export type PublicClassificationStatus = (typeof PUBLIC_CLASSIFICATION_STATUSES)[number];

/** Members a public DTO must never carry (checked by tests and the independent vector checker). */
export const PUBLIC_FORBIDDEN_MEMBERS = [
  'basis',
  'resultVersionIds',
  'derivedFrom',
  'pinnedInputIds',
  'notCurrent',
  'added',
  'removed',
  'affected',
  'staleDigest',
  'document',
  'verificationRunId',
  'evidenceCommitment',
  'evidenceBundleHash',
  'hold',
  'runId',
  'runInputHash',
  'runOutcomeHash',
  'owner',
  'ownerPrincipalId',
  'anchorId',
  'accountId',
  'requestedByAccountId',
  'publishedByAccountId',
  'candidates',
  'isStale',
  'isCurrent',
] as const;

// ───────────────────────────── shared ─────────────────────────────

/** How an entrant is displayed publicly (BRT-05 vocabulary). Private athletes are never named. */
export type PublicEntrantDisplay =
  | { readonly kind: 'ATHLETE'; readonly athleteSlug: string; readonly displayName: string }
  | { readonly kind: 'TEAM'; readonly teamName: string }
  | { readonly kind: 'PRIVATE_ENTRANT' };

export interface PublicTraceItem {
  readonly key: string;
  readonly order: ComparatorOrder;
  readonly value: string;
}

export interface PublicReadTimeStaleness<R extends string> {
  readonly state: 'CURRENT' | 'STALE';
  /** Fixed codes only; empty when CURRENT. */
  readonly reasons: readonly R[];
}

const sortedUnique = <T extends string>(xs: readonly T[]): T[] => [...new Set(xs)].sort();

// ───────────────────────────── ranking systems ─────────────────────────────

export interface RankingSystemCardFacts {
  readonly systemId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'PLATFORM' | 'OFFICIAL';
  readonly latestVersion: number;
  readonly latestLifecycle: 'PUBLISHED' | 'RETIRED';
  readonly latestSpecHash: string;
  readonly publishedVersion?: number;
  readonly displayName: string;
  readonly method: string;
  readonly disciplineVersionId: string;
  readonly metricKey: string;
  readonly markMetricId: string;
  readonly holderType: HolderType;
  readonly recognitionLevel: string;
  readonly minimumVerificationLevel: string;
  readonly effectiveFrom: string;
}

export interface PublicRankingSystemV1 {
  readonly schema: typeof PUBLIC_RANKING_SYSTEM_SCHEMA;
  readonly systemId: string;
  readonly code: string;
  readonly name: string;
  readonly displayName: string;
  readonly kind: 'PLATFORM' | 'OFFICIAL';
  /** ADR-0048 §7: computed, PLATFORM only. */
  readonly label?: string;
  /** ADR-0048 §6: an OFFICIAL system is never published by the platform. */
  readonly ownerPublication?: {
    readonly status: 'NOT_AVAILABLE';
    readonly reason: 'OWNER_PUBLICATION_UNAVAILABLE';
  };
  readonly method: string;
  readonly version: {
    readonly latest: number;
    readonly lifecycle: 'PUBLISHED' | 'RETIRED';
    readonly specHash: string;
    readonly published?: number;
  };
  readonly universe: {
    readonly disciplineVersionId: string;
    readonly metric: { readonly key: string; readonly markMetricId: string };
    readonly holderType: HolderType;
  };
  readonly requirements: {
    readonly recognitionLevel: string;
    readonly minimumVerificationLevel: string;
  };
  readonly effectiveFrom: string;
}

/** The label is COMPUTED from the kind (never read from free text). */
export function rankingSystemLabel(kind: 'PLATFORM' | 'OFFICIAL'): string | undefined {
  return kind === 'PLATFORM' ? PLATFORM_RANKING_LABEL : undefined;
}

export function publicRankingSystem(f: RankingSystemCardFacts): PublicRankingSystemV1 {
  const label = rankingSystemLabel(f.kind);
  return {
    schema: PUBLIC_RANKING_SYSTEM_SCHEMA,
    systemId: f.systemId,
    code: f.code,
    name: f.name,
    displayName: f.displayName,
    kind: f.kind,
    ...(label === undefined
      ? {
          ownerPublication: {
            status: 'NOT_AVAILABLE' as const,
            reason: 'OWNER_PUBLICATION_UNAVAILABLE' as const,
          },
        }
      : { label }),
    method: f.method,
    version: {
      latest: f.latestVersion,
      lifecycle: f.latestLifecycle,
      specHash: f.latestSpecHash,
      ...(f.publishedVersion === undefined ? {} : { published: f.publishedVersion }),
    },
    universe: {
      disciplineVersionId: f.disciplineVersionId,
      metric: { key: f.metricKey, markMetricId: f.markMetricId },
      holderType: f.holderType,
    },
    requirements: {
      recognitionLevel: f.recognitionLevel,
      minimumVerificationLevel: f.minimumVerificationLevel,
    },
    effectiveFrom: f.effectiveFrom,
  };
}

export interface PublicRankingSystemListV1 {
  readonly schema: typeof PUBLIC_RANKING_SYSTEM_LIST_SCHEMA;
  readonly items: readonly PublicRankingSystemV1[];
  readonly nextCursor?: string;
}

export function publicRankingSystemList(
  cards: readonly RankingSystemCardFacts[],
  nextCursor?: string,
): PublicRankingSystemListV1 {
  return {
    schema: PUBLIC_RANKING_SYSTEM_LIST_SCHEMA,
    items: cards.map(publicRankingSystem),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

// ───────────────────────────── snapshots ─────────────────────────────

export interface SnapshotCardFacts {
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly systemId: string;
  readonly systemCode: string;
  readonly systemVersionId: string;
  readonly systemVersion: number;
  readonly specHash: string;
  readonly kind: 'PLATFORM' | 'OFFICIAL';
  readonly method: string;
  readonly engineVersion: string;
  readonly asOf: string;
  readonly publishedAt: string;
  readonly lineageKind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
  readonly priorSnapshotId?: string;
  readonly priorSnapshotHash?: string;
  readonly lineageReasons: readonly string[];
  readonly chainPosition: number;
  readonly correctedBySnapshotId?: string;
  readonly entryCount: number;
  /** as-corrected only: every published snapshot this one stands in for. */
  readonly corrects?: readonly string[];
}

export interface PublicSnapshotSummary {
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly system: {
    readonly systemId: string;
    readonly code: string;
    readonly systemVersionId: string;
    readonly version: number;
    readonly specHash: string;
  };
  readonly kind: 'PLATFORM' | 'OFFICIAL';
  readonly label?: string;
  readonly method: string;
  readonly engineVersion: string;
  readonly asOf: string;
  readonly publishedAt: string;
  readonly lineage: {
    readonly kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
    readonly priorSnapshotId?: string;
    readonly priorSnapshotHash?: string;
    readonly reasons: readonly string[];
    readonly chainPosition: number;
    readonly correctedBy?: string;
  };
  readonly corrects?: readonly string[];
  readonly entryCount: number;
}

export function publicSnapshotSummary(c: SnapshotCardFacts): PublicSnapshotSummary {
  const label = rankingSystemLabel(c.kind);
  return {
    snapshotId: c.snapshotId,
    snapshotHash: c.snapshotHash,
    system: {
      systemId: c.systemId,
      code: c.systemCode,
      systemVersionId: c.systemVersionId,
      version: c.systemVersion,
      specHash: c.specHash,
    },
    kind: c.kind,
    ...(label === undefined ? {} : { label }),
    method: c.method,
    engineVersion: c.engineVersion,
    asOf: c.asOf,
    publishedAt: c.publishedAt,
    lineage: {
      kind: c.lineageKind,
      ...(c.priorSnapshotId === undefined ? {} : { priorSnapshotId: c.priorSnapshotId }),
      ...(c.priorSnapshotHash === undefined ? {} : { priorSnapshotHash: c.priorSnapshotHash }),
      reasons: sortedUnique(c.lineageReasons),
      chainPosition: c.chainPosition,
      ...(c.correctedBySnapshotId === undefined ? {} : { correctedBy: c.correctedBySnapshotId }),
    },
    ...(c.corrects === undefined ? {} : { corrects: [...c.corrects] }),
    entryCount: c.entryCount,
  };
}

export interface PublicRankingSnapshotHistoryV1 {
  readonly schema: typeof PUBLIC_RANKING_SNAPSHOT_HISTORY_SCHEMA;
  readonly systemId: string;
  readonly view: 'as-published' | 'as-corrected';
  readonly items: readonly PublicSnapshotSummary[];
  readonly nextCursor?: string;
}

export function publicSnapshotHistory(
  systemId: string,
  view: 'as-published' | 'as-corrected',
  cards: readonly SnapshotCardFacts[],
  nextCursor?: string,
): PublicRankingSnapshotHistoryV1 {
  return {
    schema: PUBLIC_RANKING_SNAPSHOT_HISTORY_SCHEMA,
    systemId,
    view,
    items: cards.map(publicSnapshotSummary),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Read-time snapshot staleness, public form: state + reasons; the affected pins are dropped. */
export function publicSnapshotStaleness(
  s: RankingSnapshotStaleness,
): PublicReadTimeStaleness<RankingSnapshotStaleReason> {
  return s.state === 'CURRENT'
    ? { state: 'CURRENT', reasons: [] }
    : { state: 'STALE', reasons: sortedUnique(s.reasons) };
}

export interface PublicRankingSnapshotV1 {
  readonly schema: typeof PUBLIC_RANKING_SNAPSHOT_SCHEMA;
  /** Immutable stored facts. */
  readonly snapshot: PublicSnapshotSummary;
  /** Computed at request time from the exact basis pins; never stored. */
  readonly readTime: {
    readonly staleness: PublicReadTimeStaleness<RankingSnapshotStaleReason>;
  };
}

export function publicRankingSnapshot(
  card: SnapshotCardFacts,
  staleness: RankingSnapshotStaleness,
): PublicRankingSnapshotV1 {
  return {
    schema: PUBLIC_RANKING_SNAPSHOT_SCHEMA,
    snapshot: publicSnapshotSummary(card),
    readTime: { staleness: publicSnapshotStaleness(staleness) },
  };
}

// ───────────────────────────── leaderboard ─────────────────────────────

export type PublicLeaderboardHolder =
  | { readonly holderType: 'ATHLETE'; readonly display: PublicEntrantDisplay }
  | {
      readonly holderType: 'TEAM';
      readonly teamId: string;
      readonly display: PublicEntrantDisplay;
    };

export interface LeaderboardEntryFacts {
  readonly holderType: HolderType;
  readonly holderId: string;
  readonly rank: number;
  readonly tied: boolean;
  readonly value: Mark;
  readonly comparatorTrace: readonly PublicTraceItem[];
  readonly basisCount: number;
  /** Resolved through the Passport privacy policy (athlete) or the team name (team). */
  readonly display: PublicEntrantDisplay;
}

export interface PublicLeaderboardEntry {
  readonly rank: number;
  readonly tied: boolean;
  readonly holder: PublicLeaderboardHolder;
  readonly value: Mark & { readonly display: string };
  readonly comparatorTrace: readonly PublicTraceItem[];
  /** Number of equal best Performances pinned (their topology stays in the immutable snapshot). */
  readonly basisCount: number;
}

export function publicLeaderboardEntry(e: LeaderboardEntryFacts): PublicLeaderboardEntry {
  return {
    rank: e.rank,
    tied: e.tied,
    // A private athlete is never identified, not even by id.
    holder:
      e.holderType === 'TEAM'
        ? { holderType: 'TEAM', teamId: e.holderId, display: e.display }
        : { holderType: 'ATHLETE', display: e.display },
    value: { ...e.value, display: `${e.value.value} ${e.value.unit}` },
    comparatorTrace: e.comparatorTrace.map((t) => ({ key: t.key, order: t.order, value: t.value })),
    basisCount: e.basisCount,
  };
}

export interface PublicRankingLeaderboardV1 {
  readonly schema: typeof PUBLIC_RANKING_LEADERBOARD_SCHEMA;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  /** Canonical rank order; the order inside a tie group is a set order and carries no meaning. */
  readonly entries: readonly PublicLeaderboardEntry[];
  readonly nextCursor?: string;
}

export function publicLeaderboard(
  snapshotId: string,
  snapshotHash: string,
  entries: readonly LeaderboardEntryFacts[],
  nextCursor?: string,
): PublicRankingLeaderboardV1 {
  return {
    schema: PUBLIC_RANKING_LEADERBOARD_SCHEMA,
    snapshotId,
    snapshotHash,
    entries: entries.map(publicLeaderboardEntry),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

// ───────────────────────────── classifications ─────────────────────────────

export interface ClassificationCardFacts {
  readonly resultVersionId: string;
  readonly resultId: string;
  readonly scopeType:
    'ROUND_CLASSIFICATION' | 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
  readonly scopeTargetId: string;
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly policyId: string;
  readonly policyVersionId: string;
  readonly policySpecHash: string;
  readonly disciplineVersionId: string;
  readonly engineVersion: string;
  readonly inputsDigest: string;
  readonly inputCount: number;
  readonly status: PublicClassificationStatus;
  readonly statusSince: string;
  readonly submittedAt: string;
  readonly entryCount: number;
}

export interface PublicClassificationV1 {
  readonly schema: typeof PUBLIC_CLASSIFICATION_SCHEMA;
  /** Immutable stored facts of the `@2` ResultVersion (+ its latest append-only status). */
  readonly classification: {
    readonly resultVersionId: string;
    readonly resultId: string;
    readonly scopeType: ClassificationCardFacts['scopeType'];
    readonly scopeTargetId: string;
    readonly versionNumber: number;
    readonly status: PublicClassificationStatus;
    readonly statusSince: string;
    readonly submittedAt: string;
    readonly contentHash: string;
    readonly entryCount: number;
    /** The derivation header only; the exact derivedFrom pins are not public. */
    readonly provenance: {
      readonly available: true;
      readonly policy: {
        readonly policyId: string;
        readonly policyVersionId: string;
        readonly specHash: string;
      };
      readonly disciplineVersionId: string;
      readonly engineVersion: string;
      readonly inputsDigest: string;
      readonly inputCount: number;
    };
  };
  /** Computed at request time under the PINNED policy (ADR-0047 §5); never stored. */
  readonly readTime: {
    readonly staleness: PublicReadTimeStaleness<ClassificationStaleReason>;
  };
}

/** Public classification staleness: state + reasons; the staleness document and digest are dropped. */
export function publicClassificationStaleness(
  s: ClassificationStaleness,
): PublicReadTimeStaleness<ClassificationStaleReason> {
  return s.state === 'CURRENT'
    ? { state: 'CURRENT', reasons: [] }
    : { state: 'STALE', reasons: sortedUnique(s.document.reasons) };
}

export function publicClassification(
  c: ClassificationCardFacts,
  staleness: ClassificationStaleness,
): PublicClassificationV1 {
  return {
    schema: PUBLIC_CLASSIFICATION_SCHEMA,
    classification: {
      resultVersionId: c.resultVersionId,
      resultId: c.resultId,
      scopeType: c.scopeType,
      scopeTargetId: c.scopeTargetId,
      versionNumber: c.versionNumber,
      status: c.status,
      statusSince: c.statusSince,
      submittedAt: c.submittedAt,
      contentHash: c.contentHash,
      entryCount: c.entryCount,
      provenance: {
        available: true,
        policy: {
          policyId: c.policyId,
          policyVersionId: c.policyVersionId,
          specHash: c.policySpecHash,
        },
        disciplineVersionId: c.disciplineVersionId,
        engineVersion: c.engineVersion,
        inputsDigest: c.inputsDigest,
        inputCount: c.inputCount,
      },
    },
    readTime: { staleness: publicClassificationStaleness(staleness) },
  };
}

export interface ClassificationEntryFacts {
  readonly participantId: string;
  readonly rank: number;
  readonly tied: boolean;
  readonly tieBreakKeys: readonly PublicTraceItem[];
  readonly display: PublicEntrantDisplay;
}

export interface PublicClassificationEntry {
  readonly participantId: string;
  readonly display: PublicEntrantDisplay;
  readonly rank: number;
  readonly tied: boolean;
  readonly tieBreakKeys: readonly PublicTraceItem[];
}

export interface PublicClassificationEntriesV1 {
  readonly schema: typeof PUBLIC_CLASSIFICATION_ENTRIES_SCHEMA;
  readonly resultVersionId: string;
  readonly contentHash: string;
  readonly entries: readonly PublicClassificationEntry[];
  readonly nextCursor?: string;
}

export function publicClassificationEntries(
  resultVersionId: string,
  contentHash: string,
  entries: readonly ClassificationEntryFacts[],
  nextCursor?: string,
): PublicClassificationEntriesV1 {
  return {
    schema: PUBLIC_CLASSIFICATION_ENTRIES_SCHEMA,
    resultVersionId,
    contentHash,
    entries: entries.map((e) => ({
      participantId: e.participantId,
      display: e.display,
      rank: e.rank,
      tied: e.tied,
      tieBreakKeys: e.tieBreakKeys.map((t) => ({ key: t.key, order: t.order, value: t.value })),
    })),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

// ───────────────────────────── staff (INTERNAL) ─────────────────────────────

export interface RunCardFacts {
  readonly runId: string;
  readonly systemId: string;
  readonly systemVersionId: string;
  readonly systemVersion: number;
  readonly specHash: string;
  readonly engineVersion: string;
  readonly provenance: string;
  readonly inputHash: string;
  readonly outcomeHash: string;
  readonly asOf: string;
  readonly publicationState: 'PUBLISHABLE' | 'BLOCKED';
  readonly publicationReasons: readonly string[];
  readonly entryCount: number;
  readonly candidateCount: number;
  readonly trigger: string;
  readonly recordedAt: string;
}

export interface RunCandidateFacts {
  readonly resultVersionId: string;
  readonly participantId: string;
  readonly ordinal: number;
  readonly state: string;
  readonly reasons: readonly string[];
}

/** STAFF ONLY: a run with every candidate, its state and blockers (excluded results stay visible here). */
export interface StaffRankingRunV1 {
  readonly schema: typeof STAFF_RANKING_RUN_SCHEMA;
  readonly run: Omit<RunCardFacts, 'publicationReasons'> & {
    readonly publicationReasons: readonly string[];
  };
  readonly candidates: readonly RunCandidateFacts[];
}

export function staffRankingRun(
  card: RunCardFacts,
  candidates: readonly RunCandidateFacts[],
): StaffRankingRunV1 {
  return {
    schema: STAFF_RANKING_RUN_SCHEMA,
    run: { ...card, publicationReasons: sortedUnique(card.publicationReasons) },
    candidates: candidates.map((c) => ({ ...c, reasons: sortedUnique(c.reasons) })),
  };
}

// ───────────────────────────── canonical digest (API vectors) ─────────────────────────────

/**
 * Plain SHA-256 over the JCS text of a DTO. A DTO is a response document, not a hashed domain object,
 * so no domain tag is involved; the digest exists only to pin API vectors byte for byte.
 */
export function dtoCanonicalText(dto: unknown): string {
  return serializeJcs(dto as CanonicalValue);
}

export function dtoDigest(dto: unknown): string {
  return toContentHash(sha256(new TextEncoder().encode(dtoCanonicalText(dto))));
}

/** Every forbidden member found anywhere in a DTO (JSON pointer paths). Empty = public-safe. */
export function forbiddenMembers(dto: unknown, path = ''): string[] {
  if (Array.isArray(dto)) return dto.flatMap((v, i) => forbiddenMembers(v, `${path}/${i}`));
  if (dto === null || typeof dto !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(dto)) {
    if ((PUBLIC_FORBIDDEN_MEMBERS as readonly string[]).includes(k)) out.push(`${path}/${k}`);
    out.push(...forbiddenMembers(v, `${path}/${k}`));
  }
  return out;
}
