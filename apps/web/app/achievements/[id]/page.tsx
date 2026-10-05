import { notFound } from 'next/navigation';
import { AthleteName, SupportBadge, type PublicAchievement } from '../../_lib/achievement';
import { getPublic } from '../../_lib/api';
import { Unavailable } from '../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata() {
  return { title: 'Achievement · Bragging Rights' };
}

/**
 * Achievement detail (BRT-08): the recognition, its holder (and TEAM member credits), sporting
 * context, qualifying value, the rule version that derived it, the verification of its basis AT
 * DERIVATION and its CURRENT support. No evidence, attestations, keys or authority topology.
 */
export default async function AchievementPage({ params }: Params) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await getPublic<PublicAchievement>(`/v1/achievements/${id}`);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  const a = r.data;
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>{a.typeLabel}</p>
      <h1 style={{ marginBottom: '0.25rem' }}>
        {a.displayName}
        <SupportBadge status={a.currentSupport.status} />
      </h1>
      <p style={{ margin: 0 }}>
        {a.currentSupport.statement}
        {a.currentSupport.assessedLive && (
          <small style={{ color: '#6b7280' }}> (assessed from current canonical facts now)</small>
        )}
      </p>
      {a.currentSupport.reasons.length > 0 && (
        <ul>
          {a.currentSupport.reasons.map((x) => (
            <li key={x.code}>{x.explanation}</li>
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
        {a.notice}
      </aside>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem' }}>
        <dt>Holder</dt>
        <dd>
          {a.holder.holderType === 'TEAM' ? (
            <>Team {a.holder.team.name ?? '(unnamed)'}</>
          ) : (
            <AthleteName a={a.holder.athlete} />
          )}
        </dd>
        {a.memberCredits !== undefined && (
          <>
            <dt>Credited team members</dt>
            <dd>
              {a.memberCredits.length === 0
                ? 'No credited lineup is available for this result.'
                : a.memberCredits.map((m, i) => (
                    <span key={i}>
                      {i > 0 && ', '}
                      <AthleteName a={m.athlete} />
                    </span>
                  ))}
            </dd>
          </>
        )}
        <dt>Sport / discipline</dt>
        <dd>
          {a.context.sport ?? '—'} / {a.context.discipline ?? '—'}
        </dd>
        <dt>Competition</dt>
        <dd>{a.context.competition.name ?? '—'}</dd>
        {a.context.event && (
          <>
            <dt>Event</dt>
            <dd>{a.context.event.name ?? '—'}</dd>
          </>
        )}
        {a.qualifyingValue && (
          <>
            <dt>Qualifying value</dt>
            <dd>{a.qualifyingValue.display}</dd>
          </>
        )}
        <dt>Verification</dt>
        <dd>{a.verification.statement}</dd>
        {a.verification.governingRecognition && (
          <>
            <dt>Governing recognition</dt>
            <dd>{a.verification.governingRecognition.statement}</dd>
          </>
        )}
        <dt>Rule</dt>
        <dd>
          {a.rule.code} v{a.rule.version} <small>({a.rule.engineVersion})</small>
        </dd>
        <dt>Derived at</dt>
        <dd>{a.derivedAt}</dd>
        {a.currentSupport.supersededBy && (
          <>
            <dt>Replaced by</dt>
            <dd>
              <a href={`/achievements/${a.currentSupport.supersededBy}`}>newer recognition</a>
            </dd>
          </>
        )}
      </dl>
    </main>
  );
}
