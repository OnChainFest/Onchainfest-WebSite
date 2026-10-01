import { getPublic } from '../_lib/api';
import { HolderName, HoldingBadge, Period, type HallOfFameItem } from '../_lib/record';
import { Unavailable } from '../_lib/trust';

export const dynamic = 'force-dynamic';

export async function generateMetadata() {
  return { title: 'Record Hall of Fame · Bragging Rights' };
}

type Search = { searchParams: Promise<{ scopeType?: string; cursor?: string }> };
const SCOPES = ['VENUE', 'COMPETITION', 'LEAGUE', 'PLATFORM', 'NATIONAL', 'CONTINENTAL', 'WORLD'];

/**
 * RECORD HALL OF FAME (BRT-09, ADR-0046): a rebuildable view of legitimate record history — current
 * and former holders of non-personal record categories. No induction, greatness score, ranking or
 * editorial award; pending and rescinded marks never appear here; shared records list every holder.
 */
export default async function HallOfFamePage({ searchParams }: Search) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  if (sp.scopeType !== undefined && SCOPES.includes(sp.scopeType)) q.set('scopeType', sp.scopeType);
  if (sp.cursor !== undefined && /^[A-Za-z0-9_-]{1,400}$/.test(sp.cursor))
    q.set('cursor', sp.cursor);
  q.set('limit', '50');
  const r = await getPublic<{ items: HallOfFameItem[]; nextCursor?: string; notice: string }>(
    `/v1/hall-of-fame/records?${q.toString()}`,
  );
  if (r.kind !== 'ok') return <Unavailable />;
  return (
    <main style={{ maxWidth: 900 }}>
      <h1>Record Hall of Fame</h1>
      <p>
        {SCOPES.map((s) => (
          <a key={s} href={`/hall-of-fame?scopeType=${s}`} style={{ marginRight: 8 }}>
            {s}
          </a>
        ))}
      </p>
      {r.data.items.length === 0 ? (
        <p>No records yet.</p>
      ) : (
        <ul>
          {r.data.items.map((x) => (
            <li key={x.recordMarkId}>
              <a href={`/records/${x.recordMarkId}`}>{x.recordLabel}</a> — {x.value.display} —{' '}
              <HolderName h={x.holder} />
              <HoldingBadge holding={x.holding} status={x.status} />
              <br />
              <small>
                <Period
                  from={x.effectiveFrom}
                  {...(x.effectiveTo === undefined ? {} : { to: x.effectiveTo })}
                />{' '}
                · <a href={`/record-categories/${x.categoryCode}`}>category</a>
              </small>
            </li>
          ))}
        </ul>
      )}
      {r.data.nextCursor !== undefined && (
        <a href={`/hall-of-fame?cursor=${r.data.nextCursor}`}>Next page</a>
      )}
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        {r.data.notice}
      </aside>
    </main>
  );
}
