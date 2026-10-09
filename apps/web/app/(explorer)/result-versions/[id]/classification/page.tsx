import { notFound } from 'next/navigation';
import { getPublic } from '../../../../_lib/api';
import {
  ClassificationRows,
  cursorParam,
  Facts,
  Hash,
  Notice,
  pageQuery,
  Pager,
  Pill,
  Staleness,
  UUID,
  type PublicClassification,
  type PublicClassificationEntries,
} from '../../../../_lib/ranking';
import { Unavailable } from '../../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
};

export async function generateMetadata() {
  return { title: 'Classification · Bragging Rights' };
}

const SCOPE: Record<PublicClassification['classification']['scopeType'], string> = {
  ROUND_CLASSIFICATION: 'Round classification',
  EVENT_CLASSIFICATION: 'Event classification',
  COMPETITION_CLASSIFICATION: 'Competition classification',
};

/**
 * A classification (ADR-0047): a derived ResultVersion — its card, the read-time staleness the API
 * computed under the pinned policy, and its ranked rows as derived (never re-ranked). Only versions the
 * API exposes publicly have a page; any other version answers exactly like an unknown id.
 */
export default async function ClassificationPage({ params, searchParams }: Props) {
  const { id } = await params;
  const cursor = cursorParam((await searchParams).cursor);
  if (!UUID.test(id) || cursor === null) notFound();
  const [c, rows] = await Promise.all([
    getPublic<PublicClassification>(`/v1/result-versions/${id}/classification`),
    getPublic<PublicClassificationEntries>(
      `/v1/result-versions/${id}/classification/entries?${pageQuery(cursor)}`,
      { badRequestIsNotFound: true },
    ),
  ]);
  if (c.kind === 'not_found' || rows.kind === 'not_found') notFound();
  if (c.kind === 'unavailable' || rows.kind === 'unavailable') return <Unavailable />;
  const k = c.data.classification;
  const p = k.provenance;
  return (
    <main style={{ maxWidth: 900 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        Classification result version <code>{k.resultVersionId}</code>
      </p>
      <h1 style={{ marginBottom: '0.25rem' }}>{SCOPE[k.scopeType]}</h1>
      <p style={{ marginTop: 0 }}>
        <Pill text={k.status} tone="#2563eb" /> <small>since {k.statusSince}</small>
      </p>
      <Staleness s={c.data.readTime.staleness} subject="classification" />
      <Facts>
        <dt>Result version</dt>
        <dd>
          Version {k.versionNumber}, submitted {k.submittedAt}
        </dd>
        <dt>Entries</dt>
        <dd>{k.entryCount}</dd>
        <dt>Derived by</dt>
        <dd>
          {p.engineVersion} from {p.inputCount} input results
        </dd>
        <dt>Classification policy</dt>
        <dd>
          <Hash value={p.policy.specHash} />
        </dd>
        <dt>Inputs digest</dt>
        <dd>
          <Hash value={p.inputsDigest} />
        </dd>
        <dt>Content hash</dt>
        <dd>
          <Hash value={k.contentHash} />
        </dd>
      </Facts>
      <h2>Classification</h2>
      {rows.data.entries.length === 0 ? (
        <p>No entries on this page.</p>
      ) : (
        <ClassificationRows entries={rows.data.entries} />
      )}
      <Pager
        base={`/result-versions/${k.resultVersionId}/classification`}
        cursor={cursor}
        nextCursor={rows.data.nextCursor}
      />
      <Notice>
        A classification is a result version derived from the accepted results of its scope under a
        fixed policy, and submitted through the result ledger like any other result. Ranks are shown
        exactly as derived; entrants that share a rank are tied, and the order within a shared rank
        has no meaning.
      </Notice>
    </main>
  );
}
