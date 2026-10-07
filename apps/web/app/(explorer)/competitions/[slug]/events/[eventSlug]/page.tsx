import { notFound, permanentRedirect } from 'next/navigation';
import { getPublic } from '../../../../../_lib/api';
import {
  Entrant,
  SlotView,
  StatusPill,
  when,
  type Contest,
  type Entry,
  type PublicEvent,
  type StructureRound,
} from '../../../../../_lib/competition';
import { RegistrationCtaPanel } from '../../../../../_lib/registration-cta';
import { Unavailable } from '../../../../../_lib/trust';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string; eventSlug: string }> };

async function load(slug: string, eventSlug: string) {
  const base = `/v1/competitions/${encodeURIComponent(slug)}/events/${encodeURIComponent(eventSlug)}`;
  const [event, participants, schedule, bracket] = await Promise.all([
    getPublic<PublicEvent>(base),
    getPublic<{ items: Entry[] }>(`${base}/participants`),
    getPublic<{ items: Contest[] }>(`${base}/schedule`),
    getPublic<{ rounds: StructureRound[] }>(`${base}/bracket`),
  ]);
  return { event, participants, schedule, bracket };
}

export async function generateMetadata({ params }: Params) {
  const p = await params;
  const r = await getPublic<PublicEvent>(
    `/v1/competitions/${encodeURIComponent(p.slug)}/events/${encodeURIComponent(p.eventSlug)}`,
  );
  return { title: r.kind === 'ok' ? `${r.data.event.name} · ${r.data.competition.name}` : 'Event' };
}

export default async function EventPage({ params }: Params) {
  const { slug, eventSlug } = await params;
  const { event, participants, schedule, bracket } = await load(slug, eventSlug);
  if (event.kind === 'not_found') notFound();
  if (event.kind === 'unavailable') return <Unavailable />;
  const d = event.data;
  if (d.redirected || d.canonical.competitionSlug !== slug || d.canonical.eventSlug !== eventSlug) {
    permanentRedirect(
      `/competitions/${d.canonical.competitionSlug}/events/${d.canonical.eventSlug}`,
    );
  }
  const e = d.event;
  const tz = e.timezone;
  const entries = participants.kind === 'ok' ? participants.data.items : [];
  const contests = schedule.kind === 'ok' ? schedule.data.items : [];
  const rounds = bracket.kind === 'ok' ? bracket.data.rounds : [];
  return (
    <main style={{ maxWidth: 960 }}>
      <p style={{ color: '#6b7280', fontSize: '0.85rem' }}>
        <a href={`/competitions/${d.competition.slug}`}>{d.competition.name}</a> · Event
      </p>
      <h1 style={{ marginBottom: 0 }}>
        {e.name}
        <StatusPill status={e.status} />
      </h1>
      <p style={{ color: '#6b7280' }}>
        {e.sport.name} · {e.discipline.name} (rules v{e.discipline.version}) · {e.format.name} (
        {e.format.engine})
      </p>
      <p>
        Registration: {e.status.toLowerCase().replace(/_/g, ' ')} · {e.confirmedCount} confirmed
        {e.capacity !== null && ` of ${e.capacity}`}
        {e.waitlistCount > 0 && ` · ${e.waitlistCount} on the waitlist`}
        {e.participantCount > 0 && ` · field locked with ${e.participantCount} participants`}
      </p>
      <RegistrationCtaPanel
        event={e}
        competitionStatus={d.competition.status}
        competitionSlug={d.competition.slug}
      />
      <aside
        style={{
          background: '#f3f4f6',
          padding: '0.75rem 1rem',
          borderRadius: 8,
          fontSize: '0.9rem',
        }}
      >
        This page shows how the event is operated: entries, schedule and structure. Contest and
        event statuses are operational — they are not results, and nothing here is a verified
        outcome, a ranking or a champion.
      </aside>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Participants</h2>
        {entries.length === 0 ? (
          <p style={{ color: '#6b7280' }}>No confirmed entries yet.</p>
        ) : (
          <ol>
            {entries.map((p, i) => (
              <li key={p.participantId ?? i}>
                <Entrant display={p.display} />
                {p.seed !== null && <small style={{ color: '#6b7280' }}> · seed {p.seed}</small>}
                {p.participantStatus !== null && p.participantStatus !== 'ACTIVE' && (
                  <StatusPill status={p.participantStatus} />
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Schedule</h2>
        {contests.length === 0 ? (
          <p style={{ color: '#6b7280' }}>
            No contests yet (the structure is generated after the field is locked).
          </p>
        ) : (
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th>#</th>
                <th>Round</th>
                <th>When</th>
                <th>Where</th>
                <th>Contestants</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {contests.map((c) => (
                <tr key={c.contestId} style={{ borderTop: '1px solid #e5e7eb' }}>
                  <td>{c.sequence}</td>
                  <td>{c.round.label}</td>
                  <td>{when(c.scheduledStart, tz)}</td>
                  <td>{[c.locationLabel, c.courtLabel].filter(Boolean).join(' · ') || '—'}</td>
                  <td>
                    {c.slots.map((s, i) => (
                      <span key={s.slot}>
                        {i > 0 && ' vs '}
                        <SlotView slot={s} />
                      </span>
                    ))}
                  </td>
                  <td>{c.status.toLowerCase().replace(/_/g, ' ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Structure</h2>
        {rounds.length === 0 ? (
          <p style={{ color: '#6b7280' }}>Not generated yet.</p>
        ) : (
          <div style={{ display: 'flex', gap: '1.5rem', overflowX: 'auto' }}>
            {rounds.map((r) => (
              <div key={r.sequence} style={{ minWidth: 200 }}>
                <h3 style={{ fontSize: '0.95rem' }}>{r.label}</h3>
                {r.contests.map((c) => (
                  <div
                    key={c.contestId}
                    style={{
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      padding: '0.4rem 0.6rem',
                      marginBottom: '0.5rem',
                      fontSize: '0.85rem',
                    }}
                  >
                    <small style={{ color: '#6b7280' }}>#{c.sequence}</small>
                    {c.slots.map((s) => (
                      <div key={s.slot}>
                        <SlotView slot={s} />
                      </div>
                    ))}
                  </div>
                ))}
                {r.byes.length > 0 && (
                  <p style={{ fontSize: '0.8rem', color: '#6b7280' }}>
                    Bye:{' '}
                    {r.byes.map((b) => (
                      <span key={b.participantId}>
                        <Entrant display={b.display} />{' '}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: '1.5rem' }}>
        <h2 style={{ fontSize: '1.1rem' }}>Results & standings</h2>
        <p style={{ color: '#6b7280' }}>
          <em>Not available yet.</em> Results are recorded and verified by a separate process that
          is not live yet. No winners are shown until then.
        </p>
      </section>

      {(d.plan || d.seeding) && (
        <section style={{ marginTop: '1.5rem', fontSize: '0.8rem', color: '#6b7280' }}>
          <h2 style={{ fontSize: '0.95rem' }}>How this structure was generated</h2>
          {d.field.fieldHash && (
            <p>
              Field snapshot: <code>{d.field.fieldHash}</code>
            </p>
          )}
          {d.seeding && (
            <p>
              Seeding: {d.seeding.method.toLowerCase().replace(/_/g, ' ')}
              {d.seeding.drawSeed && (
                <>
                  {' '}
                  ({d.seeding.drawAlgorithm}, seed <code>{d.seeding.drawSeed}</code>) — reproducible
                  from the stored seed; not a provably fair draw
                </>
              )}
            </p>
          )}
          {d.plan && (
            <p>
              Plan: {d.plan.engine} · input <code>{d.plan.inputHash}</code> · output{' '}
              <code>{d.plan.planHash}</code>
            </p>
          )}
        </section>
      )}
    </main>
  );
}
