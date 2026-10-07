import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../../../_lib/org-context';
import {
  categoryLooksFull,
  registrationById,
  registrationRef,
  UUID_RE,
} from '../../../../../../../_lib/registrations';
import { one, type SearchParams } from '../../../../../../../_lib/search-params';
import { dateTime } from '../../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../../_lib/tournament-context';
import { Flash } from '../../../../../../../_product/flash';
import {
  DecisionForms,
  EntrantIdentity,
  EntryTicket,
  RegistrationTimeline,
} from '../../../../../../../_product/registration-ui';
import { Fact } from '../../../../../../../_product/tournament-ui';
import { registrationDecisionAction } from '../actions';

export const metadata = { title: 'Registration · OnChainFest' };

/**
 * One registration for the organizer: identity (by the roster privacy rule), category, history and
 * the decisions the API offers. A registration of another tournament — or one the API refuses —
 * is a plain 404 here.
 */
export default async function RegistrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; competitionId: string; registrationId: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug, competitionId, registrationId }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const org = await orgContext(slug);
  if (org.kind !== 'ok') notFound();
  const t = await tournamentFor(org.ctx, competitionId);
  if (t.kind === 'not_found' || !UUID_RE.test(registrationId)) notFound();
  const r = t.kind === 'ok' ? await registrationById(org.ctx.accessToken, registrationId) : null;
  if (r?.kind === 'error') notFound();
  if (t.kind !== 'ok' || r === null || r.kind !== 'ok')
    return (
      <div className="state-block bad">
        <strong>This registration can’t be loaded right now.</strong>
        <p className="muted">Nothing was changed. Try again in a moment.</p>
      </div>
    );
  const reg = r.data;
  if (reg.competition.id !== t.data.competition.id || !reg.viewer.staff) notFound();
  const hub = `/app/orgs/${slug}/tournaments/${competitionId}/registrations`;
  const event = t.data.events.find((e) => e.id === reg.event.id);
  const keys = Object.fromEntries(
    ['CONFIRM', 'WAITLIST', 'DECLINE', 'CANCEL', 'WITHDRAW'].map((k) => [
      k,
      `oc-dec-${randomUUID()}`,
    ]),
  );
  const isFull = categoryLooksFull(event);

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={`/app/orgs/${slug}/tournaments`}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={`/app/orgs/${slug}/tournaments/${competitionId}`}>
          {t.data.competition.profile.name}
        </a>{' '}
        <span aria-hidden="true">/</span> <a href={hub}>Registrations</a>{' '}
        <span aria-hidden="true">/</span> <span>#{registrationRef(reg.id)}</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <div className="tb-layout">
        <div className="rg-main">
          <section className="rg-panel rg-person" aria-labelledby="who-h">
            <h2 id="who-h" className="sr-only">
              Participant
            </h2>
            <EntrantIdentity r={reg} />
            <div className="tb-facts">
              <Fact label="Entrant">{reg.entrantType === 'TEAM' ? 'Team' : 'Individual'}</Fact>
              <Fact label="Entered">{dateTime(reg.requestedAt, reg.event.timezone) ?? '—'}</Fact>
              <Fact label="Eligibility">
                {reg.eligibilityBasis === 'ORGANIZER_ACCEPTED'
                  ? 'Accepted by organizer'
                  : reg.eligibilityBasis === 'DECLARED'
                    ? 'Declared by entrant'
                    : 'Declared on entry'}
              </Fact>
            </div>
          </section>
          <EntryTicket r={reg} />
          <section className="rg-panel" aria-labelledby="hist-h">
            <h2 id="hist-h" className="mono muted">
              History
            </h2>
            <RegistrationTimeline r={reg} />
          </section>
        </div>
        <aside className="tb-side">
          <section className="tb-panel" aria-labelledby="dec-h">
            <h3 id="dec-h" className="mono muted">
              Decision
            </h3>
            {isFull && reg.actions.decisions.includes('CONFIRM') ? (
              <p className="muted small">
                This category is at capacity: confirming will be refused until a place frees up.
              </p>
            ) : null}
            <DecisionForms
              r={reg}
              action={registrationDecisionAction}
              hidden={{ slug, competitionId, return: 'detail' }}
              keys={keys}
              full={isFull}
            />
          </section>
        </aside>
      </div>
    </>
  );
}
