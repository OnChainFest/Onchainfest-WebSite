import { notFound } from 'next/navigation';
import { getPublic } from '../../_lib/api';
import { AthleteName } from '../../_lib/achievement';
import { HolderName, HoldingBadge, Period, type PublicRecordMark } from '../../_lib/record';
import { Unavailable } from '../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata() {
  return { title: 'Record · Bragging Rights' };
}

/**
 * Record detail (BRT-09): holder, value, effective period, status (pending and rescinded marks are
 * labelled as NOT records), the category universe, the verification of the basis and the safe
 * ratification state. No evidence, attestation topology, grants, anchors, keys or private identity.
 */
export default async function RecordPage({ params }: Params) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await getPublic<PublicRecordMark>(`/v1/records/${id}`);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  const m = r.data;
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>{m.statusLabel}</p>
      <h1 style={{ marginBottom: '0.25rem' }}>
        {m.recordLabel}
        <HoldingBadge holding={m.holding} status={m.status} />
      </h1>
      <p style={{ margin: 0 }}>{m.statusStatement}</p>
      {m.currentSupport !== undefined && (
        <p>
          {m.currentSupport.statement}
          {m.currentSupport.reasons.map((x) => (
            <small key={x.code}> {x.explanation}</small>
          ))}
        </p>
      )}
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        {m.notice}
      </aside>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem' }}>
        <dt>Holder</dt>
        <dd>
          <HolderName h={m.holder} />
        </dd>
        {m.memberCredits !== undefined && (
          <>
            <dt>Credited team members</dt>
            <dd>
              {m.memberCredits.map((c, i) => (
                <span key={i}>
                  {i > 0 && ', '}
                  <AthleteName a={c.athlete} />
                </span>
              ))}
            </dd>
          </>
        )}
        <dt>Value</dt>
        <dd>{m.value.display}</dd>
        <dt>Effective period</dt>
        <dd>
          <Period
            from={m.effectiveFrom}
            {...(m.effectiveTo === undefined ? {} : { to: m.effectiveTo })}
          />
        </dd>
        <dt>Category</dt>
        <dd>
          <a href={`/record-categories/${m.category.code}`}>{m.category.name}</a> (version{' '}
          {m.category.version}, {m.category.scopeType})
        </dd>
        <dt>Recognition</dt>
        <dd>
          {m.recognition.level}
          {m.recognition.region !== undefined && ` · ${m.recognition.region.join(', ')}`}
          {m.recognition.sport !== undefined && ` · ${m.recognition.sport}`}
        </dd>
        <dt>Verification</dt>
        <dd>{m.verification.statement}</dd>
        <dt>Ratification</dt>
        <dd>{m.ratification.statement}</dd>
        {m.recordSetAchievementId !== undefined && (
          <>
            <dt>Record set achievement</dt>
            <dd>
              <a href={`/achievements/${m.recordSetAchievementId}`}>View</a>
            </dd>
          </>
        )}
      </dl>
    </main>
  );
}
