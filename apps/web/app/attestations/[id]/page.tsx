import { notFound } from 'next/navigation';
import { getPublic } from '../../_lib/api';
import { claimText, trustFacets, type PublicAttestation } from '../../_lib/attestation';
import { Unavailable } from '../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function load(id: string) {
  if (!UUID.test(id)) return { kind: 'not_found' as const };
  return getPublic<PublicAttestation>(`/v1/attestations/${id}`);
}

export async function generateMetadata() {
  return { title: 'Signed claim · Bragging Rights' };
}

/** Minimal trust explorer (BRT-06): metadata of a signed claim only — never private evidence. */
export default async function AttestationPage({ params }: Params) {
  const { id } = await params;
  const r = await load(id);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  const a = r.data;
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>Cryptographically signed claim</p>
      <h1 style={{ marginBottom: '0.25rem' }}>{claimText(a)}</h1>
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
          margin: '1rem 0',
        }}
      >
        {a.notice}
      </aside>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.35rem 1rem' }}>
        <dt>Issuer</dt>
        <dd>
          {a.issuer.organizationSlug ? (
            <a href={`/organizations/${a.issuer.organizationSlug}`}>{a.issuer.label}</a>
          ) : (
            a.issuer.label
          )}{' '}
          <span style={{ color: '#6b7280' }}>({a.issuer.type.toLowerCase()})</span>
        </dd>
        <dt>Claim type</dt>
        <dd>
          {a.claim.type} · {a.claim.polarity}
        </dd>
        <dt>Subject</dt>
        <dd>
          Result version <code>{a.subject.resultVersionId}</code>
        </dd>
        <dt>Received</dt>
        <dd>{a.issuedOn}</dd>
        <dt>Evidence</dt>
        <dd>
          {a.evidence.count} cited item(s), {a.evidence.available} currently available
        </dd>
        <dt>Proof</dt>
        <dd>
          {a.proof.proofType} / {a.proof.scheme}
        </dd>
      </dl>
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>What is and is not established</h2>
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {trustFacets(a).map((f) => (
            <li key={f.label} style={{ marginBottom: '0.6rem' }}>
              <span
                style={{
                  border: `1px solid ${f.tone}`,
                  color: f.tone,
                  borderRadius: 999,
                  padding: '0 0.5rem',
                  fontSize: '0.8rem',
                  marginRight: '0.5rem',
                  whiteSpace: 'nowrap',
                }}
              >
                {f.label}
              </span>
              <span style={{ color: '#374151', fontSize: '0.9rem' }}>{f.detail}</span>
            </li>
          ))}
        </ul>
      </section>
      {a.supersedesAttestationId && (
        <p style={{ fontSize: '0.9rem' }}>
          Corrects an earlier claim:{' '}
          <a href={`/attestations/${a.supersedesAttestationId}`}>{a.supersedesAttestationId}</a>
        </p>
      )}
    </main>
  );
}
