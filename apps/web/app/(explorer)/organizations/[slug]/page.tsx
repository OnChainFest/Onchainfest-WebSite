import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic, type PublicOrganization } from '../../../_lib/api';
import { SectionBlock, TrustBadge, Unavailable } from '../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return getPublic<PublicOrganization>(`/v1/organizations/${encodeURIComponent(slug)}`);
}

export async function generateMetadata({ params }: Params) {
  const r = await load((await params).slug);
  return {
    title:
      r.kind === 'ok'
        ? `${r.data.organization.profile.displayName} · Organization`
        : 'Organization',
  };
}

export default async function OrganizationPage({ params }: Params) {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  if (r.data.redirected || r.data.canonicalSlug !== slug)
    permanentRedirect(`/organizations/${r.data.canonicalSlug}`);
  const o = r.data.organization;
  const p = o.profile;
  // Only https URLs are accepted by the API; render as text-only link with rel=nofollow.
  return (
    <main style={{ maxWidth: 760 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        Organization · {o.orgType.toLowerCase().replace(/_/g, ' ')}
      </p>
      <h1 style={{ marginBottom: 0 }}>
        {p.displayName}
        <TrustBadge provenance={p.provenance} />
      </h1>
      <p style={{ color: '#6b7280' }}>@{o.slug}</p>
      {o.status === 'SUSPENDED' && (
        <p style={{ color: '#b45309' }}>This organization is currently suspended.</p>
      )}
      {p.description && <p>{p.description}</p>}
      <p>
        {p.country && (
          <>
            Country: {p.country}
            {p.region ? ` (${p.region})` : ''}{' '}
          </>
        )}
        {p.website && (
          <>
            ·{' '}
            <a href={p.website} rel="nofollow noopener noreferrer ugc" target="_blank">
              {p.website}
            </a>
          </>
        )}
        {p.publicContact && <> · Contact: {p.publicContact}</>}
      </p>
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        This profile is described by the organization itself. Being listed on Bragging Rights —
        whatever the organization type — does not mean it is recognized as a sporting authority.
      </aside>
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Sporting authority</h2>
        <p style={{ color: '#6b7280' }}>
          <em>Not available yet.</em> Recognition and authority grants are not published here yet.
        </p>
      </section>
      <SectionBlock
        title="Athletes"
        section={r.data.affiliations}
        empty="No public athletes."
        render={(x, i) => (
          <li key={i}>
            <a href={`/athletes/${x.athleteSlug}`}>{x.displayName}</a> — {x.role.toLowerCase()}{' '}
            since {x.since.slice(0, 10)}
            <TrustBadge provenance={x.provenance} />
          </li>
        )}
      />
    </main>
  );
}
