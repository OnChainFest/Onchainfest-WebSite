import type { ReactNode } from 'react';
import { Entrant, type EntrantDisplay } from './competition';

/**
 * BRT-10 public ranking / classification presentation (Step 12). The types mirror the Step 11 DTOs
 * (`packages/rankings/src/public.ts`) exactly; every value is rendered as the API returned it. The web
 * never sorts rows, recomputes or breaks ranks, parses marks into numbers, stores or derives
 * staleness, or shows a ranking-run / basis / owner / account id (the DTOs carry none). A RankingSnapshot
 * is an immutable published table, never a sporting Result; a classification IS a ResultVersion.
 */

export interface PublicRankingSystem {
  schema: 'br:public-ranking-system@1';
  systemId: string;
  code: string;
  name: string;
  displayName: string;
  kind: 'PLATFORM' | 'OFFICIAL';
  label?: string;
  ownerPublication?: { status: 'NOT_AVAILABLE'; reason: 'OWNER_PUBLICATION_UNAVAILABLE' };
  method: string;
  version: {
    latest: number;
    lifecycle: 'PUBLISHED' | 'RETIRED';
    specHash: string;
    published?: number;
  };
  universe: {
    disciplineVersionId: string;
    metric: { key: string; markMetricId: string };
    holderType: 'ATHLETE' | 'TEAM';
  };
  requirements: { recognitionLevel: string; minimumVerificationLevel: string };
  effectiveFrom: string;
}

export interface PublicRankingSystemList {
  schema: 'br:public-ranking-system-list@1';
  items: PublicRankingSystem[];
  nextCursor?: string;
}

export interface PublicSnapshotSummary {
  snapshotId: string;
  snapshotHash: string;
  system: {
    systemId: string;
    code: string;
    systemVersionId: string;
    version: number;
    specHash: string;
  };
  kind: 'PLATFORM' | 'OFFICIAL';
  label?: string;
  method: string;
  engineVersion: string;
  asOf: string;
  publishedAt: string;
  lineage: {
    kind: 'INITIAL' | 'FOLLOWS' | 'CORRECTS';
    priorSnapshotId?: string;
    priorSnapshotHash?: string;
    reasons: string[];
    chainPosition: number;
    correctedBy?: string;
  };
  corrects?: string[];
  entryCount: number;
}

export type HistoryView = 'as-published' | 'as-corrected';

export interface PublicSnapshotHistory {
  schema: 'br:public-ranking-snapshot-history@1';
  systemId: string;
  view: HistoryView;
  items: PublicSnapshotSummary[];
  nextCursor?: string;
}

export interface ReadTimeStaleness {
  state: 'CURRENT' | 'STALE';
  reasons: string[];
}

export interface PublicRankingSnapshot {
  schema: 'br:public-ranking-snapshot@1';
  snapshot: PublicSnapshotSummary;
  readTime: { staleness: ReadTimeStaleness };
}

export interface TraceItem {
  key: string;
  order: string;
  value: string;
}

export interface PublicLeaderboardEntry {
  rank: number;
  tied: boolean;
  holder:
    | { holderType: 'ATHLETE'; display: EntrantDisplay }
    | { holderType: 'TEAM'; teamId: string; display: EntrantDisplay };
  value: { metricId: string; value: string; unit: string; precision: number; display: string };
  comparatorTrace: TraceItem[];
  basisCount: number;
}

export interface PublicLeaderboard {
  schema: 'br:public-ranking-leaderboard@1';
  snapshotId: string;
  snapshotHash: string;
  entries: PublicLeaderboardEntry[];
  nextCursor?: string;
}

export interface PublicClassification {
  schema: 'br:public-classification@1';
  classification: {
    resultVersionId: string;
    resultId: string;
    scopeType: 'ROUND_CLASSIFICATION' | 'EVENT_CLASSIFICATION' | 'COMPETITION_CLASSIFICATION';
    scopeTargetId: string;
    versionNumber: number;
    status: 'PROVISIONAL' | 'OFFICIAL' | 'FINAL';
    statusSince: string;
    submittedAt: string;
    contentHash: string;
    entryCount: number;
    provenance: {
      available: true;
      policy: { policyId: string; policyVersionId: string; specHash: string };
      disciplineVersionId: string;
      engineVersion: string;
      inputsDigest: string;
      inputCount: number;
    };
  };
  readTime: { staleness: ReadTimeStaleness };
}

export interface PublicClassificationEntry {
  participantId: string;
  display: EntrantDisplay;
  rank: number;
  tied: boolean;
  tieBreakKeys: TraceItem[];
}

export interface PublicClassificationEntries {
  schema: 'br:public-classification-entries@1';
  resultVersionId: string;
  contentHash: string;
  entries: PublicClassificationEntry[];
  nextCursor?: string;
}

// ───────────────────────────── route parameters ─────────────────────────────

/** The API's own parameter shapes: a malformed value is a 404 page, never an API call. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SYSTEM_REF =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9][a-z0-9-]{1,63})$/;
export const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
export const PAGE_LIMIT = '50';
export const HISTORY_VIEWS: readonly HistoryView[] = ['as-published', 'as-corrected'];

/**
 * The opaque API cursor, passed through untouched. `undefined` = first page; `null` = malformed (the
 * page answers 404 — an invalid cursor is never silently treated as the first page).
 */
export function cursorParam(raw: string | string[] | undefined): string | undefined | null {
  if (raw === undefined) return undefined;
  return typeof raw === 'string' && CURSOR.test(raw) ? raw : null;
}

/** Query string for an API page: the cursor as given and the bounded page size. */
export function pageQuery(cursor: string | undefined, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams(extra);
  if (cursor !== undefined) q.set('cursor', cursor);
  q.set('limit', PAGE_LIMIT);
  return q.toString();
}

// ───────────────────────────── shared pieces ─────────────────────────────

const muted = { color: '#6b7280', fontSize: '0.85rem' } as const;
const grid = {
  display: 'grid',
  gridTemplateColumns: 'max-content minmax(0, 1fr)',
  gap: '0.35rem 1rem',
} as const;
const mono = { fontSize: '0.8rem', overflowWrap: 'anywhere' } as const;

export function Pill({ text, tone }: { text: string; tone: string }) {
  return (
    <span
      style={{
        border: `1px solid ${tone}`,
        color: tone,
        borderRadius: 999,
        padding: '0 0.5rem',
        fontSize: '0.8rem',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </span>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <aside
      style={{
        background: '#f3f4f6',
        padding: '0.75rem 1rem',
        borderRadius: 8,
        fontSize: '0.9rem',
        margin: '1rem 0',
      }}
    >
      {children}
    </aside>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl style={grid}>{children}</dl>;
}

export function Hash({ value }: { value: string }) {
  return <code style={mono}>{value}</code>;
}

export const day = (iso: string) => iso.slice(0, 10);

/** Recognition semantics exactly as returned: PLATFORM carries the computed label; OFFICIAL never does. */
export function SystemKind({
  s: { kind, label, ownerPublication },
}: {
  s: Pick<PublicRankingSystem, 'kind' | 'label' | 'ownerPublication'>;
}) {
  if (kind === 'PLATFORM') return <Pill text={label ?? 'Platform ranking'} tone="#2563eb" />;
  return (
    <>
      <Pill text="Official ranking system" tone="#6b7280" />
      {ownerPublication !== undefined && (
        <small style={{ marginLeft: 6 }}>
          Owner publication {ownerPublication.status === 'NOT_AVAILABLE' && 'not available'} — this
          platform never publishes an official ranking on an owner&apos;s behalf.
        </small>
      )}
    </>
  );
}

/** Fixed explanations for the API's fixed reason codes; an unknown code is shown verbatim. */
const STALE_EXPLANATIONS: Record<string, string> = {
  BASIS_RESULT_NOT_CURRENT:
    'A result this snapshot was built on is no longer the current final version of that result.',
  BASIS_VERIFICATION_NOT_CURRENT:
    'A verification this snapshot was built on is no longer the current verification of that result.',
  PINNED_INPUT_NOT_CURRENT:
    'A result this classification was derived from is no longer the current version of that result.',
  ADMISSIBLE_INPUT_SET_CHANGED:
    'The results that qualify as inputs for this scope have changed since it was derived.',
  ADMISSIBLE_INPUT_SET_UNKNOWN:
    'The current inputs for this scope could not be determined, so it is not treated as current.',
};

/**
 * Read-time staleness as the API computed it for THIS request. Nothing is stored or inferred here;
 * STALE never means the stored facts changed.
 */
export function Staleness({ s, subject }: { s: ReadTimeStaleness; subject: string }) {
  return (
    <section style={{ margin: '1rem 0' }}>
      {s.state === 'CURRENT' ? (
        <p style={{ margin: 0 }}>
          <Pill text="Current at read time" tone="#15803d" /> Nothing this {subject} depends on has
          changed as of this page load.
        </p>
      ) : (
        <>
          <p style={{ margin: 0 }}>
            <Pill text="Stale at read time" tone="#b45309" /> The {subject} itself is unchanged, but
            something it depends on has changed since it was produced:
          </p>
          <ul data-staleness-reasons="">
            {s.reasons.map((r) => (
              <li key={r}>
                <code>{r}</code> — {STALE_EXPLANATIONS[r] ?? 'See the reason code.'}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** A rank exactly as returned. A shared rank is marked, never broken (1, 1, 3 stays 1, 1, 3). */
export function RankCell({ rank, tied }: { rank: number; tied: boolean }) {
  return (
    <td style={{ whiteSpace: 'nowrap' }} data-rank={rank} data-tied={tied ? 'true' : 'false'}>
      {rank}
      {tied && (
        <small title="Shared rank" style={{ marginLeft: 4, color: '#6b7280' }}>
          (shared)
        </small>
      )}
    </td>
  );
}

export function Trace({ items }: { items: TraceItem[] }) {
  return (
    <>
      {items.map((t, i) => (
        <span key={i}>
          {i > 0 && '; '}
          <code>{t.key}</code> {t.value} ({t.order})
        </span>
      ))}
    </>
  );
}

const th = { textAlign: 'left', padding: '0.25rem 0.75rem 0.25rem 0' } as const;
const td = { padding: '0.25rem 0.75rem 0.25rem 0', verticalAlign: 'top' } as const;

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Rows in the API's canonical order. The order inside a tie group carries no meaning (ADR-0049). */
export function LeaderboardRows({ entries }: { entries: PublicLeaderboardEntry[] }) {
  return (
    <Table head={['Rank', 'Holder', 'Mark', 'Comparison', 'Equal best marks']}>
      {entries.map((e, i) => (
        <tr key={i} data-row="">
          <RankCell rank={e.rank} tied={e.tied} />
          <td style={td}>
            {e.holder.holderType === 'TEAM' && 'Team '}
            <Entrant display={e.holder.display} />
          </td>
          <td style={td} data-value="">
            {e.value.display}
          </td>
          <td style={td}>
            <Trace items={e.comparatorTrace} />
          </td>
          <td style={td}>{e.basisCount}</td>
        </tr>
      ))}
    </Table>
  );
}

export function ClassificationRows({ entries }: { entries: PublicClassificationEntry[] }) {
  return (
    <Table head={['Rank', 'Entrant', 'Tie-break keys']}>
      {entries.map((e, i) => (
        <tr key={i} data-row="">
          <RankCell rank={e.rank} tied={e.tied} />
          <td style={td}>
            <Entrant display={e.display} />
          </td>
          <td style={td}>
            <Trace items={e.tieBreakKeys} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** Forward-only cursor paging (the API has no offsets and no previous cursor). */
export function Pager({
  base,
  cursor,
  nextCursor,
  extra = {},
}: {
  base: string;
  cursor: string | undefined;
  nextCursor: string | undefined;
  extra?: Record<string, string>;
}) {
  const href = (c?: string) => {
    const q = new URLSearchParams(extra);
    if (c !== undefined) q.set('cursor', c);
    const s = q.toString();
    return s === '' ? base : `${base}?${s}`;
  };
  if (cursor === undefined && nextCursor === undefined) return null;
  return (
    <nav style={{ margin: '0.75rem 0', display: 'flex', gap: '1rem' }}>
      {cursor !== undefined && <a href={href()}>First page</a>}
      {nextCursor !== undefined && (
        <a href={href(nextCursor)} rel="next">
          Next page
        </a>
      )}
    </nav>
  );
}

export function Muted({ children }: { children: ReactNode }) {
  return <p style={muted}>{children}</p>;
}
