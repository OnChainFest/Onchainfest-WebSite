import { notFound } from 'next/navigation';
import { getPublic } from '../../_lib/api';
import {
  cursorParam,
  day,
  Muted,
  Notice,
  pageQuery,
  Pager,
  SystemKind,
  type PublicRankingSystemList,
} from '../../_lib/ranking';
import { Unavailable } from '../../_lib/trust';

export const dynamic = 'force-dynamic';

type Search = { searchParams: Promise<{ cursor?: string | string[] }> };

export async function generateMetadata() {
  return { title: 'Ranking systems · Bragging Rights' };
}

/**
 * Public ranking systems (BRT-10, ADR-0048): the definitions whose latest version is PUBLISHED or
 * RETIRED. Read-only: no definition, evaluation or publication control exists on the web.
 */
export default async function RankingSystemsPage({ searchParams }: Search) {
  const cursor = cursorParam((await searchParams).cursor);
  if (cursor === null) notFound();
  const r = await getPublic<PublicRankingSystemList>(`/v1/ranking-systems?${pageQuery(cursor)}`, {
    badRequestIsNotFound: true,
  });
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  return (
    <main style={{ maxWidth: 900 }}>
      <h1>Ranking systems</h1>
      <Notice>
        A ranking system defines how published ranking snapshots are built: one discipline, one
        metric, one holder type and fixed requirements. A snapshot is an immutable published table —
        it is not a sporting result.
      </Notice>
      {r.data.items.length === 0 ? (
        <p>No public ranking systems yet.</p>
      ) : (
        <ul>
          {r.data.items.map((s) => (
            <li key={s.systemId} style={{ marginBottom: '0.75rem' }}>
              <a href={`/ranking-systems/${s.code}`}>{s.displayName}</a> <SystemKind s={s} />
              {s.version.lifecycle === 'RETIRED' && <small> · retired</small>}
              <Muted>
                <code>{s.code}</code> · {s.method} · {s.universe.holderType} · metric{' '}
                <code>{s.universe.metric.key}</code> · effective from {day(s.effectiveFrom)}
              </Muted>
            </li>
          ))}
        </ul>
      )}
      <Pager base="/ranking-systems" cursor={cursor} nextCursor={r.data.nextCursor} />
    </main>
  );
}
