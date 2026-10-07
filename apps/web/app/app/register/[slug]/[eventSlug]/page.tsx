import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { getPublic } from '../../../../_lib/api';
import { appContext } from '../../../../_lib/app-context';
import type { PublicCompetition, PublicEvent } from '../../../../_lib/competition';
import { publicOrganization } from '../../../../_lib/org-context';
import {
  activeEntry,
  CTA_COPY,
  myRegistrations,
  registerPath,
  registrationCta,
  type RegistrationCta,
} from '../../../../_lib/registrations';
import { one, type SearchParams } from '../../../../_lib/search-params';
import { categoryChips, dateRange, dateTime } from '../../../../_lib/tournament-builder';
import type { CompetitionStatus } from '../../../../_lib/tournaments';
import { Flash } from '../../../../_product/flash';
import { brandStyle } from '../../../../_product/org-chrome';
import { RegistrationStatusChip } from '../../../../_product/registration-ui';
import { SubmitButton } from '../../../../_product/submit-button';
import { Fact, SportGlyph, TournamentArt } from '../../../../_product/tournament-ui';
import { registerAction } from '../../actions';

export const metadata = { title: 'Enter · OnChainFest' };

type Params = { params: Promise<{ slug: string; eventSlug: string }>; searchParams: SearchParams };

/**
 * ONCF-04 athlete registration: Category → Participant → Review → Result. Everything shown comes
 * from the public competition/event read and the caller's own platform rows (`/v1/me`,
 * `/v1/me/registrations`). Whether the entry is accepted — window, capacity, duplicates, who may
 * enter whom — is decided by the registration command, never here.
 */
export default async function RegisterPage({ params, searchParams }: Params) {
  const [{ slug, eventSlug }, query] = await Promise.all([params, searchParams]);
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null; // the layout renders the blocked state

  const base = `/v1/competitions/${encodeURIComponent(slug)}`;
  const [event, comp] = await Promise.all([
    getPublic<PublicEvent>(`${base}/events/${encodeURIComponent(eventSlug)}`),
    getPublic<PublicCompetition>(base),
  ]);
  if (event.kind === 'not_found' || comp.kind === 'not_found') notFound();
  if (event.kind === 'unavailable' || comp.kind === 'unavailable')
    return (
      <div className="state-block bad">
        <strong>This tournament can’t be loaded right now.</strong>
        <p className="muted">Nothing was submitted. Try again in a moment.</p>
      </div>
    );
  const d = event.data;
  if (d.canonical.competitionSlug !== slug || d.canonical.eventSlug !== eventSlug)
    redirect(registerPath(d.canonical.competitionSlug, d.canonical.eventSlug));

  const c = comp.data.competition;
  const e = d.event;
  const here = registerPath(slug, eventSlug);
  const publicEvent = `/competitions/${slug}/events/${eventSlug}`;
  const cta = registrationCta(e, c.status, new Date());
  const organizer = c.organizer.slug !== null ? await publicOrganization(c.organizer.slug) : null;
  const athletes = ctx.account.me.athletes;
  const mine = athletes.length > 0 ? await myRegistrations(ctx.session.accessToken) : null;
  const entries = mine?.kind === 'ok' ? mine.data.items : [];

  const step = one(query.step) === 'review' ? 'review' : 'participant';
  const requested = one(query.athlete);
  const selected =
    athletes.find((a) => a.athleteId === requested) ??
    (athletes.length === 1 ? athletes[0] : undefined);
  const existing =
    selected === undefined ? undefined : activeEntry(entries, e.id, selected.athleteId);
  const reviewing = step === 'review' && selected !== undefined && existing === undefined;
  const chips = categoryChips(e.category);
  const when = dateRange(e.startsAt ?? c.startsAt, e.endsAt ?? c.endsAt, e.timezone);
  const closes = dateTime(e.registration.closesAt, e.timezone);
  const isSelf = (personId: string) => personId === ctx.account.me.selfPersonId;

  return (
    <div className="rg-flow" style={brandStyle(organizer?.organization.profile.accentColor)}>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={`/competitions/${slug}`}>{c.name}</a> <span aria-hidden="true">/</span>{' '}
        <a href={publicEvent}>{e.name}</a> <span aria-hidden="true">/</span> <span>Enter</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="tb-hero rg-hero">
        <TournamentArt
          startsAt={e.startsAt ?? c.startsAt}
          timezone={e.timezone}
          status={c.status as CompetitionStatus}
          size="hero"
        >
          {organizer !== null ? (
            <span className="rg-org mono">{organizer.organization.profile.displayName}</span>
          ) : null}
        </TournamentArt>
        <div className="tb-hero-body">
          <span className="mono muted">{c.name}</span>
          <h1 className="tb-hero-title">{e.name}</h1>
          <span className="rg-sport">
            <SportGlyph code={e.sport.code} name={e.sport.name} size={32} />
            <span>
              {e.sport.name} · {e.discipline.name}
            </span>
          </span>
          {chips.length > 0 ? (
            <span className="tb-chips">
              {chips.map((x) => (
                <span key={x} className="chip mono">
                  {x}
                </span>
              ))}
            </span>
          ) : null}
          <div className="tb-facts">
            <Fact label="Dates">{when ?? 'To be announced'}</Fact>
            <Fact label="Venue">{c.locationLabel ?? 'To be announced'}</Fact>
            <Fact label="Format">{e.format.name}</Fact>
            <Fact label="Entrants">
              {e.entrantKind === 'TEAM'
                ? 'Teams'
                : e.entrantKind === 'INDIVIDUAL'
                  ? 'Individual'
                  : '—'}
            </Fact>
            <Fact label="Registration closes">{closes ?? 'No deadline set'}</Fact>
            <Fact label="Places">
              {e.capacity === null
                ? `${e.confirmedCount} confirmed · no cap`
                : `${e.confirmedCount} of ${e.capacity} confirmed`}
              {e.waitlistCount > 0 ? ` · ${e.waitlistCount} waitlisted` : ''}
            </Fact>
          </div>
        </div>
      </header>

      <ol className="rg-progress" aria-label="Registration steps">
        <li data-state="done">
          <span className="mono">01</span> Category
        </li>
        <li data-state={reviewing ? 'done' : 'current'}>
          <span className="mono">02</span> Participant
        </li>
        <li data-state={reviewing ? 'current' : 'todo'}>
          <span className="mono">03</span> Review
        </li>
        <li data-state="todo">
          <span className="mono">04</span> Status
        </li>
      </ol>

      {cta.kind !== 'open' ? (
        <Unavailable cta={cta} timezone={e.timezone} back={publicEvent} />
      ) : athletes.length === 0 ? (
        <section className="rg-panel" aria-labelledby="prof-h">
          <h2 id="prof-h" className="rg-h2">
            First, your athlete profile
          </h2>
          <p className="muted">
            Entries are made for an athlete profile. Create yours — it takes a minute — and you’ll
            come straight back to this category.
          </p>
          <a
            className="btn btn-cyan"
            href={`/app/onboarding?path=athlete&add=1&next=${encodeURIComponent(here)}`}
          >
            Create athlete profile →
          </a>
        </section>
      ) : existing !== undefined ? (
        <section className="rg-panel" aria-labelledby="dup-h">
          <h2 id="dup-h" className="rg-h2">
            Already entered
          </h2>
          <p className="muted">@{selected?.slug} already has an entry in this category.</p>
          <div className="rg-row-inline">
            <RegistrationStatusChip status={existing.status} />
            <a className="btn btn-cyan btn-sm" href={`/app/registrations/${existing.id}`}>
              View entry →
            </a>
          </div>
          {athletes.length > 1 ? (
            <a className="link mono small" href={here}>
              Enter another athlete
            </a>
          ) : null}
        </section>
      ) : reviewing && selected !== undefined ? (
        <section className="rg-panel rg-review" aria-labelledby="rev-h">
          <h2 id="rev-h" className="rg-h2">
            Review your entry
          </h2>
          <dl className="rg-summary">
            <div>
              <dt className="mono">Tournament</dt>
              <dd>{c.name}</dd>
            </div>
            <div>
              <dt className="mono">Category</dt>
              <dd>
                {e.name}
                <span className="muted small"> · {e.discipline.name}</span>
              </dd>
            </div>
            <div>
              <dt className="mono">Participant</dt>
              <dd>
                @{selected.slug}
                <span className="muted small">
                  {isSelf(selected.personId) ? ' · you' : ' · athlete you manage'}
                </span>
              </dd>
            </div>
            <div>
              <dt className="mono">Dates</dt>
              <dd>{when ?? 'To be announced'}</dd>
            </div>
            <div>
              <dt className="mono">Registration closes</dt>
              <dd>{closes ?? 'No deadline set'}</dd>
            </div>
            <div>
              <dt className="mono">Places</dt>
              <dd>
                {e.capacity === null
                  ? 'No cap'
                  : e.confirmedCount >= e.capacity
                    ? `Full (${e.capacity}) — your entry may be waitlisted or held for review`
                    : `${e.capacity - e.confirmedCount} of ${e.capacity} left`}
              </dd>
            </div>
          </dl>
          <form action={registerAction} className="rg-confirm-entry">
            <input type="hidden" name="competitionSlug" value={slug} />
            <input type="hidden" name="eventSlug" value={eventSlug} />
            <input type="hidden" name="eventId" value={e.id} />
            <input type="hidden" name="athleteId" value={selected.athleteId} />
            {/* Fixed per rendered review: a double click or a resubmission is one registration. */}
            <input type="hidden" name="key" value={`oc-reg-${randomUUID()}`} />
            <label className="rg-declare">
              <input type="checkbox" name="eligibility" value="yes" required />
              <span>
                I confirm @{selected.slug} meets this category’s requirements
                {chips.length > 0 ? ` (${chips.join(' · ')})` : ''}. The organizer may check it.
              </span>
            </label>
            <p className="muted small">
              Depending on the organizer’s setup, your entry is confirmed straight away, held for
              their review, or waitlisted when the category is full. You’ll see the result next.
            </p>
            <SubmitButton pending="Submitting entry" className="btn btn-cyan btn-full rg-cta">
              Confirm registration
            </SubmitButton>
          </form>
          {athletes.length > 1 ? (
            <a className="link mono small" href={here}>
              ← Change participant
            </a>
          ) : null}
        </section>
      ) : (
        <section className="rg-panel" aria-labelledby="who-h">
          <h2 id="who-h" className="rg-h2">
            Who’s entering?
          </h2>
          <form method="get" action={here} className="rg-pick">
            <input type="hidden" name="step" value="review" />
            <div className="rg-athletes" role="radiogroup" aria-labelledby="who-h">
              {athletes.map((a, i) => {
                const entry = activeEntry(entries, e.id, a.athleteId);
                return (
                  <label
                    key={a.athleteId}
                    className="rg-athlete"
                    data-entered={entry !== undefined}
                  >
                    <input
                      type="radio"
                      name="athlete"
                      value={a.athleteId}
                      defaultChecked={
                        selected === undefined ? i === 0 : selected.athleteId === a.athleteId
                      }
                      required
                    />
                    <span className="rg-avatar" aria-hidden="true">
                      {a.slug.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="rg-who-text">
                      <strong>@{a.slug}</strong>
                      <span className="mono muted">
                        {isSelf(a.personId) ? 'You' : 'Athlete you manage'}
                      </span>
                    </span>
                    {entry !== undefined ? <RegistrationStatusChip status={entry.status} /> : null}
                  </label>
                );
              })}
            </div>
            <button className="btn btn-cyan rg-cta" type="submit">
              Review entry →
            </button>
          </form>
        </section>
      )}
    </div>
  );
}

function Unavailable({
  cta,
  timezone,
  back,
}: {
  cta: RegistrationCta;
  timezone: string;
  back: string;
}) {
  const detail =
    cta.kind === 'opens'
      ? `Entries open ${dateTime(cta.at, timezone) ?? 'soon'}. Come back then.`
      : cta.kind === 'team'
        ? 'This category takes team entries. Team entry isn’t available online yet — contact the organizer.'
        : cta.kind === 'cancelled'
          ? 'This category was cancelled by the organizer.'
          : cta.kind === 'not_open'
            ? 'The organizer hasn’t opened entries for this category yet.'
            : 'This category isn’t taking entries any more.';
  return (
    <section className="rg-panel" data-tone="muted" aria-labelledby="na-h">
      <span
        className="tb-status mono"
        data-status={cta.kind === 'cancelled' ? 'CANCELLED' : 'REGISTRATION_CLOSED'}
      >
        <span aria-hidden="true" />
        {CTA_COPY[cta.kind]}
      </span>
      <h2 id="na-h" className="rg-h2">
        Entries aren’t open
      </h2>
      <p className="muted">{detail}</p>
      <a className="btn btn-ghost btn-sm" href={back}>
        Back to the category
      </a>
    </section>
  );
}
