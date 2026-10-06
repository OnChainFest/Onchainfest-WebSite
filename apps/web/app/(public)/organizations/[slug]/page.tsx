import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic, type PublicCompetitionCard, type PublicOrganization } from '../../../_lib/api';
import { ORG_TYPE_LABEL } from '../../../_lib/org-context';
import { Brand } from '../../../_product/brand';
import { brandStyle, OrgMark } from '../../../_product/org-chrome';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

const load = (slug: string) =>
  getPublic<PublicOrganization>(`/v1/organizations/${encodeURIComponent(slug)}`);

const dateFmt = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export async function generateMetadata({ params }: Params) {
  const r = await load((await params).slug);
  if (r.kind !== 'ok') return { title: 'Organization · OnChainFest' };
  const p = r.data.organization.profile;
  return {
    title: `${p.displayName} · OnChainFest`,
    description: p.description ?? `${p.displayName} on OnChainFest.`,
    openGraph: {
      title: p.displayName,
      description: p.description ?? undefined,
      ...(p.logoUrl ? { images: [p.logoUrl] } : {}),
    },
  };
}

/**
 * Public organization page. Shows only what the public API serves: the self-described profile,
 * published (non-draft) tournaments and athletes whose public profiles list the affiliation.
 * No roster, member ids or private data are ever fetched here.
 */
export default async function OrganizationPage({ params }: Params) {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable')
    return (
      <div className="oc oc-app">
        <main>
          <div className="state-block bad">
            <h1 className="page-title">Temporarily unavailable</h1>
            <p className="muted">This page can’t be loaded right now. Try again shortly.</p>
          </div>
        </main>
      </div>
    );
  if (r.data.redirected || r.data.canonicalSlug !== slug)
    permanentRedirect(`/organizations/${r.data.canonicalSlug}`);
  const o = r.data.organization;
  const p = o.profile;
  const comps = await getPublic<{ items: PublicCompetitionCard[] }>(
    `/v1/organizations/${encodeURIComponent(o.slug)}/competitions`,
  );
  const competitions = comps.kind === 'ok' ? comps.data.items : null;
  const athletes = r.data.affiliations.status === 'AVAILABLE' ? r.data.affiliations.items : [];

  return (
    <div className="oc oc-app pub" style={brandStyle(p.accentColor)}>
      <header className="topbar">
        <div className="bar">
          <Brand />
          <a className="btn btn-ghost btn-sm pub-cta" href="/signup">
            Join OnChainFest
          </a>
        </div>
      </header>
      <section className="pub-hero">
        <div className="pub-hero-inner">
          <OrgMark name={p.displayName} logoUrl={p.logoUrl} size={112} />
          <div>
            <span className="mono pub-kicker">
              {ORG_TYPE_LABEL[o.orgType] ?? o.orgType.toLowerCase().replace(/_/g, ' ')}
              {p.country ? ` · ${p.country}${p.region ? ` ${p.region}` : ''}` : ''}
            </span>
            <h1 className="pub-title">{p.displayName}</h1>
            {(p.sports ?? []).length > 0 ? (
              <div className="chip-row">
                {(p.sports ?? []).map((s) => (
                  <span key={s} className="chip mono">
                    {s}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <dl className="pub-facts">
          <div>
            <dt className="mono">Tournaments</dt>
            <dd>{competitions === null ? '—' : competitions.length}</dd>
          </div>
          <div>
            <dt className="mono">Athletes</dt>
            <dd>{athletes.length}</dd>
          </div>
          {p.website ? (
            <div>
              <dt className="mono">Website</dt>
              <dd>
                <a href={p.website} rel="nofollow noopener noreferrer ugc" target="_blank">
                  {p.website.replace(/^https:\/\//, '').replace(/\/$/, '')} ↗
                </a>
              </dd>
            </div>
          ) : null}
          {p.publicContact ? (
            <div>
              <dt className="mono">Contact</dt>
              <dd>{p.publicContact}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      <main>
        {o.status === 'SUSPENDED' ? (
          <p className="flash" role="status">
            This organization is currently suspended.
          </p>
        ) : null}
        <div className="split">
          <section aria-labelledby="about-h">
            <h2 id="about-h" className="mono muted">
              About
            </h2>
            <p className="pub-about">
              {p.description ?? `${p.displayName} runs sport on OnChainFest.`}
            </p>
            <p className="muted small">
              Described by the organization itself. A listing on OnChainFest does not make an
              organization a recognized sporting authority.
            </p>
          </section>
          <section aria-labelledby="tour-h">
            <h2 id="tour-h" className="mono muted">
              Tournaments
            </h2>
            {competitions === null ? (
              <p className="muted">Tournaments are unavailable right now.</p>
            ) : competitions.length === 0 ? (
              <div className="empty">
                <span className="empty-mark" aria-hidden="true" />
                <strong>No published tournaments yet</strong>
              </div>
            ) : (
              <ul className="list">
                {competitions.map((c) => (
                  <li key={c.id}>
                    <span>
                      <strong>{c.name}</strong>
                      <span className="muted small block">
                        {[c.startsAt ? dateFmt.format(new Date(c.startsAt)) : null, c.locationLabel]
                          .filter(Boolean)
                          .join(' · ') || c.status.toLowerCase()}
                      </span>
                    </span>
                    <a className="link mono" href={`/competitions/${c.slug}`}>
                      View →
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        {athletes.length > 0 ? (
          <section aria-labelledby="ath-h" style={{ marginTop: '3rem' }}>
            <h2 id="ath-h" className="mono muted">
              Athletes
            </h2>
            <ul className="athlete-grid">
              {athletes.map((a) => (
                <li key={a.athleteSlug}>
                  <a href={`/athletes/${a.athleteSlug}`}>
                    <span className="avatar" aria-hidden="true">
                      {a.displayName.slice(0, 1)}
                    </span>
                    <strong>{a.displayName}</strong>
                    <span className="muted small">{a.role.toLowerCase()}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
