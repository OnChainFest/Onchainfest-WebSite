import { notFound } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import {
  cursorParam,
  Facts,
  Hash,
  LeaderboardRows,
  Notice,
  pageQuery,
  Pager,
  Staleness,
  SystemKind,
  UUID,
  type PublicLeaderboard,
  type PublicRankingSnapshot,
} from '../../../_lib/ranking';
import { Unavailable } from '../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
};

export async function generateMetadata() {
  return { title: 'Ranking snapshot · Bragging Rights' };
}

/**
 * One published RankingSnapshot (ADR-0048): its immutable facts and lineage, the read-time staleness
 * the API computed for this request, and its leaderboard in canonical rank order, one API page at a
 * time. A snapshot is not a sporting Result: it is never attested, verified, disputed or edited here.
 */
export default async function RankingSnapshotPage({ params, searchParams }: Props) {
  const { id } = await params;
  const cursor = cursorParam((await searchParams).cursor);
  if (!UUID.test(id) || cursor === null) notFound();
  const [s, lb] = await Promise.all([
    getPublic<PublicRankingSnapshot>(`/v1/ranking-snapshots/${id}`),
    getPublic<PublicLeaderboard>(`/v1/ranking-snapshots/${id}/leaderboard?${pageQuery(cursor)}`, {
      badRequestIsNotFound: true,
    }),
  ]);
  if (s.kind === 'not_found' || lb.kind === 'not_found') notFound();
  if (s.kind === 'unavailable' || lb.kind === 'unavailable') return <Unavailable />;
  const x = s.data.snapshot;
  const l = x.lineage;
  return (
    <main style={{ maxWidth: 960 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        <a href="/ranking-systems">Ranking systems</a> ·{' '}
        <a href={`/ranking-systems/${x.system.code}`}>
          <code>{x.system.code}</code>
        </a>{' '}
        · <a href={`/ranking-systems/${x.system.code}/snapshots`}>Snapshot history</a>
      </p>
      <h1 style={{ marginBottom: '0.25rem' }}>Ranking snapshot #{l.chainPosition}</h1>
      <p style={{ marginTop: 0 }}>
        <SystemKind s={x} /> <small>as of {x.asOf}</small>
      </p>
      {l.correctedBy !== undefined && (
        <p style={{ color: '#b45309' }}>
          This snapshot was corrected by{' '}
          <a href={`/ranking-snapshots/${l.correctedBy}`}>a later snapshot</a>. It is kept unchanged
          as part of the published history.
        </p>
      )}
      <Staleness s={s.data.readTime.staleness} subject="snapshot" />
      <Facts>
        <dt>Published</dt>
        <dd>{x.publishedAt}</dd>
        <dt>Facts as of</dt>
        <dd>{x.asOf}</dd>
        <dt>Method</dt>
        <dd>
          {x.method} · {x.engineVersion}
        </dd>
        <dt>System version</dt>
        <dd>{x.system.version}</dd>
        <dt>Entries</dt>
        <dd>{x.entryCount}</dd>
        <dt>Lineage</dt>
        <dd>
          {l.kind} · position {l.chainPosition} in the chain
          {l.priorSnapshotId !== undefined && (
            <>
              {' '}
              ·{' '}
              <a href={`/ranking-snapshots/${l.priorSnapshotId}`}>
                {l.kind === 'CORRECTS' ? 'corrects' : 'follows'} the prior snapshot
              </a>
            </>
          )}
          {l.reasons.length > 0 && <> · reasons: {l.reasons.join(', ')}</>}
        </dd>
        <dt>Snapshot hash</dt>
        <dd>
          <Hash value={x.snapshotHash} />
        </dd>
        <dt>Specification hash</dt>
        <dd>
          <Hash value={x.system.specHash} />
        </dd>
        {l.priorSnapshotHash !== undefined && (
          <>
            <dt>Prior snapshot hash</dt>
            <dd>
              <Hash value={l.priorSnapshotHash} />
            </dd>
          </>
        )}
      </Facts>
      <h2>Leaderboard</h2>
      {lb.data.entries.length === 0 ? (
        <p>No entries on this page.</p>
      ) : (
        <LeaderboardRows entries={lb.data.entries} />
      )}
      <Pager
        base={`/ranking-snapshots/${x.snapshotId}`}
        cursor={cursor}
        nextCursor={lb.data.nextCursor}
      />
      <Notice>
        A ranking snapshot is an immutable published ranking table, not a sporting result: it is not
        attested, verified or disputed, and it never changes. Ranks and marks are shown exactly as
        published; holders that share a mark share a rank, and the order within a shared rank has no
        meaning.
      </Notice>
    </main>
  );
}
