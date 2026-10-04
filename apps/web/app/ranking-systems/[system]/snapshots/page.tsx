import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import {
  cursorParam,
  HISTORY_VIEWS,
  Muted,
  Notice,
  pageQuery,
  Pager,
  SYSTEM_REF,
  type HistoryView,
  type PublicRankingSystem,
  type PublicSnapshotHistory,
  type PublicSnapshotSummary,
} from '../../../_lib/ranking';
import { Unavailable } from '../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ system: string }>;
  searchParams: Promise<{ view?: string | string[]; cursor?: string | string[] }>;
};

export async function generateMetadata() {
  return { title: 'Snapshot history · Bragging Rights' };
}

const short = (id: string) => id.slice(0, 8);

function SnapshotItem({ x, view }: { x: PublicSnapshotSummary; view: HistoryView }) {
  const l = x.lineage;
  return (
    <li style={{ marginBottom: '0.75rem' }} data-snapshot="">
      <a href={`/ranking-snapshots/${x.snapshotId}`}>
        #{l.chainPosition} · as of {x.asOf}
      </a>{' '}
      <small>
        ({l.kind}
        {l.priorSnapshotId !== undefined && (
          <>
            {' '}
            <a href={`/ranking-snapshots/${l.priorSnapshotId}`}>{short(l.priorSnapshotId)}</a>
          </>
        )}
        )
      </small>
      {l.correctedBy !== undefined && (
        <small style={{ color: '#b45309' }}>
          {' '}
          · corrected by <a href={`/ranking-snapshots/${l.correctedBy}`}>{short(l.correctedBy)}</a>
        </small>
      )}
      <Muted>
        Published {x.publishedAt} · {x.entryCount} entries · system version {x.system.version}
        {l.reasons.length > 0 && <> · reasons: {l.reasons.join(', ')}</>}
        {view === 'as-corrected' && x.corrects !== undefined && x.corrects.length > 0 && (
          <>
            {' '}
            · stands in for{' '}
            {x.corrects.map((c, i) => (
              <span key={c}>
                {i > 0 && ', '}
                <a href={`/ranking-snapshots/${c}`}>{short(c)}</a>
              </span>
            ))}
          </>
        )}
      </Muted>
    </li>
  );
}

/**
 * Snapshot history of one ranking system (ADR-0048 §5): as-published (every snapshot in chain order,
 * corrected ones marked with what corrected them) or as-corrected (each corrected snapshot replaced by
 * its final correction). Both are queries over immutable facts; nothing here is editable.
 */
export default async function SnapshotHistoryPage({ params, searchParams }: Props) {
  const { system } = await params;
  const sp = await searchParams;
  const view = sp.view ?? 'as-published';
  const cursor = cursorParam(sp.cursor);
  if (!SYSTEM_REF.test(system) || cursor === null) notFound();
  if (typeof view !== 'string' || !(HISTORY_VIEWS as readonly string[]).includes(view)) notFound();
  const v = view as HistoryView;
  const [s, h] = await Promise.all([
    getPublic<PublicRankingSystem>(`/v1/ranking-systems/${system}`),
    getPublic<PublicSnapshotHistory>(
      `/v1/ranking-systems/${system}/snapshots?${pageQuery(cursor, { view: v })}`,
      { badRequestIsNotFound: true },
    ),
  ]);
  if (s.kind === 'not_found' || h.kind === 'not_found') notFound();
  if (s.kind === 'unavailable' || h.kind === 'unavailable') return <Unavailable />;
  const code = s.data.code;
  if (code !== system) {
    const q = new URLSearchParams();
    if (v !== 'as-published') q.set('view', v);
    if (cursor !== undefined) q.set('cursor', cursor);
    const qs = q.toString();
    permanentRedirect(`/ranking-systems/${code}/snapshots${qs === '' ? '' : `?${qs}`}`);
  }
  const base = `/ranking-systems/${code}/snapshots`;
  const viewQuery: Record<string, string> = v === 'as-published' ? {} : { view: v };
  return (
    <main style={{ maxWidth: 900 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        <a href="/ranking-systems">Ranking systems</a> ·{' '}
        <a href={`/ranking-systems/${code}`}>{s.data.displayName}</a> · Snapshot history
      </p>
      <h1>Snapshot history</h1>
      <p>
        {v === 'as-published' ? (
          <>
            <strong>As published</strong> · <a href={`${base}?view=as-corrected`}>As corrected</a>
          </>
        ) : (
          <>
            <a href={base}>As published</a> · <strong>As corrected</strong>
          </>
        )}
      </p>
      {h.data.items.length === 0 ? (
        <p>No published snapshots yet.</p>
      ) : (
        <ul>
          {h.data.items.map((x) => (
            <SnapshotItem key={x.snapshotId} x={x} view={v} />
          ))}
        </ul>
      )}
      <Pager base={base} cursor={cursor} nextCursor={h.data.nextCursor} extra={viewQuery} />
      <Notice>
        {v === 'as-published'
          ? 'Every snapshot exactly as it was published, in chain order. A corrected snapshot stays in the history and names the snapshot that corrected it.'
          : 'Each corrected snapshot is replaced by its final correction, which lists the snapshots it stands in for. The published snapshots themselves are unchanged.'}
      </Notice>
    </main>
  );
}
