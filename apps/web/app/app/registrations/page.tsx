import { appContext } from '../../_lib/app-context';
import {
  GROUP_LABEL,
  groupRegistrations,
  myRegistrations,
  type RegistrationGroup,
} from '../../_lib/registrations';
import { one, type SearchParams } from '../../_lib/search-params';
import { Flash } from '../../_product/flash';
import { EntryTicket } from '../../_product/registration-ui';

export const metadata = { title: 'Your entries · OnChainFest' };

const ORDER: readonly RegistrationGroup[] = ['pending', 'upcoming', 'past', 'closed'];

/**
 * ONCF-04 athlete registration history: the caller's own entries (`GET /v1/me/registrations`:
 * athletes it may register, teams it manages). Grouped by real registration and category status.
 */
export default async function RegistrationsPage({ searchParams }: { searchParams: SearchParams }) {
  const query = await searchParams;
  const ctx = await appContext();
  if (ctx.kind !== 'ok') return null;
  const r = await myRegistrations(ctx.session.accessToken);
  const head = (
    <div className="page-head">
      <span className="mono muted">Your OnChainFest</span>
      <h1 className="page-title">
        Your <span className="outline">entries.</span>
      </h1>
    </div>
  );
  if (r.kind !== 'ok')
    return (
      <>
        {head}
        <div className="state-block bad">
          <strong>Your entries can’t be loaded right now.</strong>
          <p className="muted">Nothing changed. Try again in a moment.</p>
        </div>
      </>
    );
  const groups = groupRegistrations(r.data.items);
  return (
    <>
      {head}
      <Flash error={one(query.error)} notice={one(query.notice)} />
      {r.data.items.length === 0 ? (
        <div className="empty">
          <span className="empty-mark" aria-hidden="true" />
          <strong>No entries yet</strong>
          <p className="muted">
            {ctx.account.me.athletes.length === 0
              ? 'Create an athlete profile, then enter a tournament category from its page.'
              : 'Open a tournament from an organizer’s page and pick a category to enter.'}
          </p>
          {ctx.account.me.athletes.length === 0 ? (
            <a className="btn btn-cyan btn-sm" href="/app/onboarding?path=athlete&add=1">
              Create athlete profile
            </a>
          ) : null}
        </div>
      ) : (
        ORDER.filter((g) => groups[g].length > 0).map((g) => (
          <section key={g} className="rg-group" aria-labelledby={`g-${g}`}>
            <h2 id={`g-${g}`} className="tb-h3">
              {GROUP_LABEL[g]} <span className="tb-count">{groups[g].length}</span>
            </h2>
            <ul className="rg-tickets">
              {groups[g].map((x) => (
                <li key={x.id}>
                  <EntryTicket r={x} href={`/app/registrations/${x.id}`} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}
