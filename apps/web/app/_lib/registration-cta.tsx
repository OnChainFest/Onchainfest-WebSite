import type { EventSummary } from './competition';
import { CTA_COPY, registerPath, registrationCta } from './registrations';
import { dateTime } from './tournament-builder';

/**
 * ONCF-04 registration entry point on the public category and tournament pages (explorer styling).
 * The state comes from the public lifecycle status and window; the link goes to the authenticated
 * registration flow, so a signed-out visitor passes through sign-in with a safe `next=` and comes
 * back. The registration command re-checks everything.
 */
export function RegistrationCtaPanel({
  event,
  competitionStatus,
  competitionSlug,
}: {
  event: EventSummary;
  competitionStatus: string;
  competitionSlug: string;
}) {
  const cta = registrationCta(event, competitionStatus, new Date());
  const open = cta.kind === 'open';
  const closes = dateTime(event.registration.closesAt, event.timezone);
  const detail =
    cta.kind === 'open'
      ? closes !== null
        ? `Entries close ${closes}.`
        : 'Sign in to enter an athlete.'
      : cta.kind === 'opens'
        ? `Entries open ${dateTime(cta.at, event.timezone) ?? 'soon'}.`
        : cta.kind === 'team'
          ? 'This category takes team entries, which aren’t available online yet.'
          : null;
  return (
    <section
      aria-label="Registration"
      data-cta={cta.kind}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        margin: '1rem 0',
        padding: '0.9rem 1rem',
        borderRadius: 8,
        border: `1px solid ${open ? '#0891b2' : '#d1d5db'}`,
        background: open ? '#ecfeff' : '#f9fafb',
      }}
    >
      <div>
        <strong>{CTA_COPY[cta.kind]}</strong>
        {detail !== null ? (
          <div style={{ color: '#4b5563', fontSize: '0.9rem' }}>{detail}</div>
        ) : null}
      </div>
      {open ? (
        <a
          href={registerPath(competitionSlug, event.slug)}
          style={{
            background: '#0e7490',
            color: '#fff',
            padding: '0.55rem 1.1rem',
            borderRadius: 6,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Register
        </a>
      ) : null}
    </section>
  );
}

/** Compact variant for a tournament's category list. */
export function RegistrationCtaLink({
  event,
  competitionStatus,
  competitionSlug,
}: {
  event: EventSummary;
  competitionStatus: string;
  competitionSlug: string;
}) {
  const cta = registrationCta(event, competitionStatus, new Date());
  if (cta.kind !== 'open') return null;
  return (
    <>
      {' · '}
      <a href={registerPath(competitionSlug, event.slug)} style={{ fontWeight: 600 }}>
        Register →
      </a>
    </>
  );
}
