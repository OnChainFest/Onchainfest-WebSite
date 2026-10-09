import { notFound } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import { Unavailable } from '../../../_lib/trust';
import { LevelLadder, Notice, type PublicVerificationRun } from '../../../_lib/verification';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function generateMetadata() {
  return { title: 'Verification run · Bragging Rights' };
}

/**
 * Verification explorer (BRT-07): ONE historical, immutable evaluation — the level it reached under
 * a named policy version, its level ladder and the next blocked level with its public reason. It is
 * labelled historical: whether it is still current is shown on the result version's verification
 * page (hash-based freshness). No trace, identities, grants, keys or private evidence.
 */
export default async function VerificationRunPage({ params }: Params) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const r = await getPublic<PublicVerificationRun>(`/v1/verification-runs/${id}/summary`);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  const v = r.data;
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>Historical verification run</p>
      <h1 style={{ marginBottom: '0.25rem' }}>
        {v.level === undefined ? 'No level established' : `${v.label} (${v.level})`}
      </h1>
      <p style={{ margin: 0 }}>{v.statement}</p>
      <Notice text={v.notice} />
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem' }}>
        <dt>Competition</dt>
        <dd>{v.context.competition.name}</dd>
        {v.context.event && (
          <>
            <dt>Event</dt>
            <dd>{v.context.event.name ?? '—'}</dd>
          </>
        )}
        <dt>Result version</dt>
        <dd>
          <a href={`/result-versions/${v.context.resultVersionId}/verification`}>
            <code>{v.context.resultVersionId}</code>
          </a>{' '}
          <span style={{ color: '#6b7280', fontSize: '0.85rem' }}>(current status)</span>
        </dd>
        <dt>Evaluation state</dt>
        <dd>{v.evaluationState}</dd>
        <dt>Policy</dt>
        <dd>
          {v.policy.code} v{v.policy.version}
        </dd>
        <dt>Engine</dt>
        <dd>
          <code>{v.engineVersion}</code>
        </dd>
        <dt>Facts known as of</dt>
        <dd>{v.evaluatedAsOf}</dd>
        <dt>Active dispute</dt>
        <dd>{v.activeDispute ? 'Yes — a dispute claim was active' : 'No'}</dd>
      </dl>
      <LevelLadder levels={v.levels} next={v.next} />
    </main>
  );
}
