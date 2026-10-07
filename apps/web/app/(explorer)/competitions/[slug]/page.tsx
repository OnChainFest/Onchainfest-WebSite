import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import { StatusPill, when, type PublicCompetition } from '../../../_lib/competition';
import { RegistrationCtaLink } from '../../../_lib/registration-cta';
import { Unavailable } from '../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  return getPublic<PublicCompetition>(`/v1/competitions/${encodeURIComponent(slug)}`);
}

export async function generateMetadata({ params }: Params) {
  const r = await load((await params).slug);
  return { title: r.kind === 'ok' ? `${r.data.competition.name} · Competition` : 'Competition' };
}

export default async function CompetitionPage({ params }: Params) {
  const { slug } = await params;
  const r = await load(slug);
  if (r.kind === 'not_found') notFound();
  if (r.kind === 'unavailable') return <Unavailable />;
  if (r.data.redirected || r.data.canonicalSlug !== slug)
    permanentRedirect(`/competitions/${r.data.canonicalSlug}`);
  const c = r.data.competition;
  return (
    <main style={{ maxWidth: 860 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>Competition</p>
      <h1 style={{ marginBottom: 0 }}>
        {c.name}
        <StatusPill status={c.status} />
      </h1>
      <p style={{ color: '#6b7280' }}>
        Organized by{' '}
        {c.organizer.slug !== null ? (
          <a href={`/organizations/${c.organizer.slug}`}>{c.organizer.displayName}</a>
        ) : (
          (c.organizer.displayName ?? 'an organization')
        )}
        {c.locationLabel && <> · {c.locationLabel}</>}
      </p>
      <p>
        {when(c.startsAt, c.timezone)} → {when(c.endsAt, c.timezone)}
      </p>
      {c.description && <p>{c.description}</p>}
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        Competition statuses are operational. A completed competition does not mean its results are
        final or verified, and organizing a competition confers no sporting authority.
      </aside>
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Events</h2>
        {r.data.events.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No public events yet.</p>
        ) : (
          <ul>
            {r.data.events.map((e) => (
              <li key={e.id} style={{ marginBottom: '0.5rem' }}>
                <a href={`/competitions/${c.slug}/events/${e.slug}`}>{e.name}</a>
                <StatusPill status={e.status} />
                <RegistrationCtaLink
                  event={e}
                  competitionStatus={c.status}
                  competitionSlug={c.slug}
                />
                <br />
                <small style={{ color: '#6b7280' }}>
                  {e.discipline.name} (v{e.discipline.version}) · {e.format.name} ·{' '}
                  {e.participantCount > 0
                    ? `${e.participantCount} participants`
                    : `${e.confirmedCount} confirmed`}
                  {e.capacity !== null && ` / ${e.capacity}`}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Results & sporting authority</h2>
        <p style={{ color: '#6b7280' }}>
          <em>Not available yet.</em> Verified results and recognized authority are not published
          here yet — nothing is shown rather than something unverified.
        </p>
      </section>
    </main>
  );
}
