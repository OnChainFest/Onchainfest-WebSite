import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { appContext } from '../../../_lib/app-context';
import { attributeContext } from '../../../_lib/entry-attributes';
import {
  REGISTRATION_STATUS_COPY,
  registrationById,
  registrationRef,
  UUID_RE,
} from '../../../_lib/registrations';
import { one, type SearchParams } from '../../../_lib/search-params';
import { dateTime } from '../../../_lib/tournament-builder';
import { EntryAttributesPanel } from '../../../_product/entry-attributes';
import { Flash } from '../../../_product/flash';
import {
  EntrantIdentity,
  EntryTicket,
  RegistrationStatusChip,
  RegistrationTimeline,
} from '../../../_product/registration-ui';
import { declareAttributesAction, withdrawRegistrationAction } from '../../register/actions';

export const metadata = { title: 'Your entry · OnChainFest' };

/**
 * ONCF-04 registration result: the persisted registration as the API reports it to its entrant.
 * Reloading shows the current state; the organizer's decisions appear here as they are made.
 */
export default async function RegistrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ registrationId: string }>;
  searchParams: SearchParams;
}) {
  const [{ registrationId }, query] = await Promise.all([params, searchParams]);
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null;
  if (!UUID_RE.test(registrationId)) notFound();
  const r = await registrationById(ctx.session.accessToken, registrationId);
  if (r.kind === 'error') notFound();
  if (r.kind !== 'ok')
    return (
      <div className="state-block bad">
        <strong>This entry can’t be loaded right now.</strong>
        <p className="muted">Nothing changed. Try again in a moment.</p>
      </div>
    );
  const reg = r.data;
  // Only the entrant's view lives here; staff manage entries from the organization area.
  if (!reg.viewer.entrant) notFound();
  const own = ctx.account.me.athletes.find((a) => a.athleteId === reg.athleteId);
  const publicEvent = `/competitions/${reg.competition.slug}/events/${reg.event.slug}`;
  // ONCF-05B: declared entry values, editable by the entrant until the field locks.
  const active = ['REQUESTED', 'WAITLISTED', 'CONFIRMED'].includes(reg.status);
  const attrs = active ? await attributeContext(ctx.session.accessToken, reg) : null;

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href="/app/registrations">Your entries</a> <span aria-hidden="true">/</span>{' '}
        <span>#{registrationRef(reg.id)}</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="rg-result" data-status={reg.status}>
        <RegistrationStatusChip status={reg.status} size="lg" />
        <h1 className="rg-result-title">{reg.event.name}</h1>
        <p className="rg-result-copy">{REGISTRATION_STATUS_COPY[reg.status]}</p>
        {reg.reason !== null && reg.status !== 'CONFIRMED' ? (
          <p className="rg-result-reason">
            <span className="mono muted">Organizer note</span> <q>{reg.reason}</q>
          </p>
        ) : null}
        <div className="rg-result-meta mono muted">
          <span>Ref #{registrationRef(reg.id)}</span>
          <span>Entered {dateTime(reg.requestedAt, reg.event.timezone) ?? reg.requestedAt}</span>
        </div>
      </header>

      <div className="tb-layout">
        <div className="rg-main">
          <EntryTicket r={reg} />
          <section className="rg-panel" aria-labelledby="who-h">
            <h2 id="who-h" className="mono muted">
              Participant
            </h2>
            <EntrantIdentity r={reg} {...(own === undefined ? {} : { ownSlug: own.slug })} />
          </section>
          {attrs !== null ? (
            <EntryAttributesPanel
              registrationId={reg.id}
              ctx={attrs}
              action={declareAttributesAction}
            />
          ) : null}
          <section className="rg-panel" aria-labelledby="hist-h">
            <h2 id="hist-h" className="mono muted">
              Progress
            </h2>
            <RegistrationTimeline r={reg} />
          </section>
        </div>
        <aside className="tb-side">
          <section className="tb-panel" aria-labelledby="next-h">
            <h3 id="next-h" className="mono muted">
              Next
            </h3>
            <NextStep status={reg.status} />
            <a className="btn btn-ghost btn-full" href={publicEvent}>
              Category page ↗
            </a>
            <a className="btn btn-ghost btn-full" href="/app/registrations">
              All your entries
            </a>
            {reg.actions.withdraw ? (
              <details className="confirm rg-confirm">
                <summary className="btn btn-ghost btn-sm">Withdraw entry</summary>
                <form action={withdrawRegistrationAction} className="rg-confirm-form">
                  <input type="hidden" name="registrationId" value={reg.id} />
                  <input type="hidden" name="key" value={`oc-wd-${randomUUID()}`} />
                  <p className="muted small">
                    Your place is released
                    {reg.status === 'CONFIRMED'
                      ? ' and may go to the next athlete on the waitlist'
                      : ''}
                    . This can’t be undone.
                  </p>
                  <button className="btn btn-danger btn-sm" type="submit">
                    Withdraw — confirm
                  </button>
                </form>
              </details>
            ) : null}
          </section>
        </aside>
      </div>
    </>
  );
}

function NextStep({ status }: { status: string }) {
  const text: Record<string, string> = {
    REQUESTED: 'Nothing to do now. The organizer decides on your entry; check back here.',
    WAITLISTED: 'Keep an eye on this page — a freed place can move you into the field.',
    CONFIRMED: 'You’re in the field. Draws and schedule appear on the category page.',
    DECLINED: 'Contact the organizer if you think this is a mistake.',
    WITHDRAWN: 'You can enter again while registration is open.',
    CANCELLED: 'Contact the organizer for details.',
  };
  return <p className="muted small">{text[status]}</p>;
}
