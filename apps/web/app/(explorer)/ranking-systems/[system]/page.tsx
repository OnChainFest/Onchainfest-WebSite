import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import {
  day,
  Facts,
  Hash,
  Notice,
  SYSTEM_REF,
  SystemKind,
  type PublicRankingSystem,
} from '../../../_lib/ranking';
import { Unavailable } from '../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ system: string }> };

export async function generateMetadata() {
  return { title: 'Ranking system · Bragging Rights' };
}

/**
 * One ranking system (BRT-10): its universe, requirements and version facts as published, and the
 * way into its snapshot history. The canonical URL uses the system code; a uuid redirects to it.
 */
export default async function RankingSystemPage({ params }: Params) {
  const { system } = await params;
  if (!SYSTEM_REF.test(system)) notFound();
  const r = await getPublic<PublicRankingSystem>(`/v1/ranking-systems/${system}`);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  const s = r.data;
  if (s.code !== system) permanentRedirect(`/ranking-systems/${s.code}`);
  const history = `/ranking-systems/${s.code}/snapshots`;
  return (
    <main style={{ maxWidth: 820 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        <a href="/ranking-systems">Ranking systems</a> · <code>{s.code}</code>
      </p>
      <h1 style={{ marginBottom: '0.25rem' }}>{s.displayName}</h1>
      <p style={{ marginTop: 0 }}>
        <SystemKind s={s} />
      </p>
      <Facts>
        <dt>Name</dt>
        <dd>{s.name}</dd>
        <dt>Method</dt>
        <dd>{s.method}</dd>
        <dt>Holders</dt>
        <dd>{s.universe.holderType}</dd>
        <dt>Metric</dt>
        <dd>
          <code>{s.universe.metric.key}</code> ({s.universe.metric.markMetricId})
        </dd>
        <dt>Recognition level</dt>
        <dd>{s.requirements.recognitionLevel}</dd>
        <dt>Minimum verification</dt>
        <dd>{s.requirements.minimumVerificationLevel}</dd>
        <dt>Effective from</dt>
        <dd>{day(s.effectiveFrom)}</dd>
        <dt>Latest version</dt>
        <dd>
          {s.version.latest} ({s.version.lifecycle})
          {s.version.published !== undefined && ` · published version ${s.version.published}`}
        </dd>
        <dt>Specification hash</dt>
        <dd>
          <Hash value={s.version.specHash} />
        </dd>
      </Facts>
      <h2>Snapshot history</h2>
      <ul>
        <li>
          <a href={history}>As published</a> — every snapshot in publication order, corrected ones
          included and marked.
        </li>
        <li>
          <a href={`${history}?view=as-corrected`}>As corrected</a> — each corrected snapshot
          replaced by its final correction.
        </li>
      </ul>
      <Notice>
        Snapshots are immutable. A correction is a new snapshot that names the one it corrects;
        nothing published is ever edited. Ranks come from the system&apos;s fixed comparator and
        aggregation; shared marks share a rank.
      </Notice>
    </main>
  );
}
