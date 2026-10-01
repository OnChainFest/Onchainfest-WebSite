import { notFound } from 'next/navigation';
import { getPublic } from '../../_lib/api';
import { HolderName, HoldingBadge, Period, type PublicRecordMark } from '../../_lib/record';
import { Unavailable } from '../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ code: string }> };
const REF = /^([0-9a-f-]{36}|[a-z0-9][a-z0-9-]{1,63})$/;

interface Category {
  code: string;
  name: string;
  displayName: string;
  scopeType: string;
  version: number;
  metric: string;
  comparator?: string;
  tiePolicy: string;
  recognitionLevel: string;
  region?: string[];
  minimumVerificationLevel: string;
  notice: string;
}

export async function generateMetadata() {
  return { title: 'Record category · Bragging Rights' };
}

/** Record category (BRT-09): its comparison universe, current holder(s) and full chronology. */
export default async function RecordCategoryPage({ params }: Params) {
  const { code } = await params;
  if (!REF.test(code)) notFound();
  const [c, cur, hist] = await Promise.all([
    getPublic<Category>(`/v1/record-categories/${code}`),
    getPublic<{ status: string; current: PublicRecordMark[] }>(
      `/v1/record-categories/${code}/current`,
    ),
    getPublic<{ items: PublicRecordMark[] }>(`/v1/record-categories/${code}/history?limit=50`),
  ]);
  if (c.kind === 'not_found') notFound();
  if (c.kind === 'unavailable' || cur.kind !== 'ok' || hist.kind !== 'ok') return <Unavailable />;
  const cat = c.data;
  return (
    <main style={{ maxWidth: 820 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        {cat.scopeType} · recognition {cat.recognitionLevel}
        {cat.region !== undefined && ` (${cat.region.join(', ')})`} · floor{' '}
        {cat.minimumVerificationLevel}
      </p>
      <h1>{cat.displayName}</h1>
      <p>
        Metric <code>{cat.metric}</code> ({cat.comparator ?? 'comparator'}), ties: {cat.tiePolicy},
        version {cat.version}.
      </p>
      <h2>Current record</h2>
      {cur.data.current.length === 0 ? (
        <p>No current record.</p>
      ) : (
        <ul>
          {cur.data.current.map((m) => (
            <li key={m.recordMarkId}>
              <a href={`/records/${m.recordMarkId}`}>{m.value.display}</a> —{' '}
              <HolderName h={m.holder} /> (since {m.effectiveFrom.slice(0, 10)})
            </li>
          ))}
        </ul>
      )}
      <h2>History</h2>
      {hist.data.items.length === 0 ? (
        <p>No history yet.</p>
      ) : (
        <ul>
          {hist.data.items.map((m) => (
            <li key={m.recordMarkId}>
              <a href={`/records/${m.recordMarkId}`}>{m.value.display}</a> —{' '}
              <HolderName h={m.holder} /> <HoldingBadge holding={m.holding} status={m.status} />
              <br />
              <small>
                <Period
                  from={m.effectiveFrom}
                  {...(m.effectiveTo === undefined ? {} : { to: m.effectiveTo })}
                />{' '}
                · {m.statusLabel}
              </small>
            </li>
          ))}
        </ul>
      )}
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        {cat.notice}
      </aside>
    </main>
  );
}
