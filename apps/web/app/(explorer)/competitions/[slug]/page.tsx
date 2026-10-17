import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic } from '../../../_lib/api';
import {
  Entrant,
  OFFICIAL_AUTHORITY_NOTE,
  placeLabel,
  StatusPill,
  when,
  type PublicCompetition,
  type PublicCompetitionOutcome,
} from '../../../_lib/competition';
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
  // ONCF-L6: each category's champion(s) once it is completed (OFFICIAL results only).
  const outcome = await getPublic<PublicCompetitionOutcome>(
    `/v1/competitions/${encodeURIComponent(c.slug)}/outcome`,
  );
  const outcomeOf = new Map(
    (outcome.kind === 'ok' ? outcome.data.events : []).map((e) => [e.id, e]),
  );
  const completed = r.data.events.filter((e) => e.status === 'COMPLETED').length;
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
        Competition statuses are operational. A completed category carries its final outcome from
        official results — declared by the organizer, not independently verified. Organizing a
        competition confers no sporting authority.
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
                <Champions champions={outcomeOf.get(e.id)?.champions ?? null} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Results</h2>
        <p style={{ color: '#6b7280' }}>
          {c.status === 'COMPLETED'
            ? `Competition completed · ${completed} ${completed === 1 ? 'category' : 'categories'} with a final result.`
            : c.status === 'CANCELLED'
              ? 'Competition cancelled — no further results.'
              : completed > 0
                ? `${completed} ${completed === 1 ? 'category has' : 'categories have'} a final result; open an event for its standings and official results.`
                : 'Final results appear per category once it is completed; open an event for its official results so far.'}{' '}
          {OFFICIAL_AUTHORITY_NOTE}. Recognized sporting authority is not published here.
        </p>
      </section>
    </main>
  );
}

/** The champion(s) of a completed, decided category — joint when tied; nothing otherwise. */
function Champions({
  champions,
}: {
  champions: PublicCompetitionOutcome['events'][number]['champions'];
}) {
  if (champions === null || champions.length === 0) return null;
  return (
    <div style={{ fontSize: '0.85rem' }}>
      <strong>{placeLabel(1, champions.length)}:</strong>{' '}
      {champions.map((p, i) => (
        <span key={p.participantId}>
          {i > 0 && ' · '}
          <Entrant display={p.display} />
        </span>
      ))}
    </div>
  );
}
