import { notFound } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import { Unavailable } from '../../../_lib/trust';
import { LevelLadder, Notice, type PublicVerification } from '../../../_lib/verification';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata() {
  return { title: 'Result verification · Bragging Rights' };
}

const FRESHNESS: Record<PublicVerification['freshness'], { text: string; tone: string }> = {
  CURRENT: { text: 'Current', tone: '#15803d' },
  STALE: { text: 'Stale — re-evaluation required', tone: '#b45309' },
  NOT_EVALUATED: { text: 'Not evaluated', tone: '#6b7280' },
};

/**
 * Current verification of an exact result version (BRT-07). A level is shown as current ONLY when
 * the latest run's snapshot hash equals the current canonical facts' hash; a stale run is shown as
 * "last evaluated", never as the current level.
 */
export default async function ResultVerificationPage({ params }: Params) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await getPublic<PublicVerification>(`/v1/result-versions/${id}/verification`);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  const v = r.data;
  const f = FRESHNESS[v.freshness];
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        Verification of result version <code>{v.resultVersionId}</code>
      </p>
      <h1 style={{ marginBottom: '0.25rem' }}>
        {v.freshness === 'CURRENT' && v.level !== undefined ? `${v.label} (${v.level})` : f.text}
      </h1>
      <p style={{ margin: 0 }}>
        <span
          style={{
            border: `1px solid ${f.tone}`,
            color: f.tone,
            borderRadius: 999,
            padding: '0 0.5rem',
            fontSize: '0.8rem',
          }}
        >
          {f.text}
        </span>{' '}
        {v.statement}
      </p>
      <Notice text={v.notice} />
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem' }}>
        <dt>Evaluation state</dt>
        <dd>{v.evaluationState}</dd>
        {v.policy && (
          <>
            <dt>Applicable policy</dt>
            <dd>
              {v.policy.code} v{v.policy.version}
            </dd>
          </>
        )}
        {v.evaluatedAsOf && (
          <>
            <dt>Facts known as of</dt>
            <dd>{v.evaluatedAsOf}</dd>
          </>
        )}
        {v.lastEvaluated && v.freshness !== 'CURRENT' && (
          <>
            <dt>Last evaluated</dt>
            <dd>
              <a href={`/verifications/${v.lastEvaluated.runId}`}>
                {v.lastEvaluated.level === undefined
                  ? 'no level'
                  : `${v.lastEvaluated.label} (${v.lastEvaluated.level})`}
              </a>{' '}
              under {v.lastEvaluated.policy.code} v{v.lastEvaluated.policy.version}, facts as of{' '}
              {v.lastEvaluated.evaluatedAsOf} — historical, not current
            </dd>
          </>
        )}
        <dt>Active dispute</dt>
        <dd>{v.activeDispute ? 'Yes — a dispute claim is active' : 'No'}</dd>
        {v.runId && (
          <>
            <dt>Run</dt>
            <dd>
              <a href={`/verifications/${v.runId}`}>{v.runId}</a>
            </dd>
          </>
        )}
      </dl>
      {v.levels && <LevelLadder levels={v.levels} next={v.next} />}
    </main>
  );
}
