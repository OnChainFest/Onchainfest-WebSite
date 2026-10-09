import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../../_lib/org-context';
import {
  categoryLooksFull,
  competitionRegistrations,
  REGISTRATION_STATUS_LABEL,
  REGISTRATION_STATUSES,
  registrationFilter,
  type Registration,
} from '../../../../../../_lib/registrations';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import { dateTime } from '../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import type { ManagedEvent } from '../../../../../../_lib/tournaments';
import { Flash } from '../../../../../../_product/flash';
import {
  DecisionForms,
  EntrantIdentity,
  RegistrationStatusChip,
} from '../../../../../../_product/registration-ui';
import { SportGlyph, StatusBadge } from '../../../../../../_product/tournament-ui';
import { registrationDecisionAction } from './actions';

export const metadata = { title: 'Registrations · OnChainFest' };

/**
 * ONCF-04 registration management for one tournament. Rows, counts and filters come from
 * GET /v1/competitions/:id/registrations (COMP_VIEW_PRIVATE; server-side filters and paging);
 * the decisions offered per row are the API's `actions` (COMP_MANAGE_REGISTRATIONS + lifecycle).
 */
export default async function RegistrationsHubPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; competitionId: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug, competitionId }, query] = await Promise.all([params, searchParams]);
  const org = await orgContext(slug);
  if (org.kind !== 'ok') notFound();
  const t = await tournamentFor(org.ctx, competitionId);
  if (t.kind === 'not_found') notFound();
  const filter = registrationFilter({
    category: one(query.category),
    status: one(query.status),
    after: one(query.after),
  });
  const page =
    t.kind === 'ok'
      ? await competitionRegistrations(org.ctx.accessToken, competitionId, filter)
      : null;
  // Unknown category or stale cursor (400/404): nothing to show under this tournament.
  if (page?.kind === 'error') notFound();
  if (t.kind !== 'ok' || page === null || page.kind !== 'ok')
    return (
      <div className="state-block bad">
        <strong>Registrations can’t be loaded right now.</strong>
        <p className="muted">Nothing was changed. Try again in a moment.</p>
      </div>
    );

  const { competition: c, events } = t.data;
  const base = `/app/orgs/${slug}/tournaments/${c.id}`;
  const hub = `${base}/registrations`;
  const { items, counts, nextCursor } = page.data;
  const total = REGISTRATION_STATUSES.reduce((n, s) => n + counts[s], 0);
  const byId = new Map(events.map((e) => [e.id, e]));
  const selected = filter.eventId === undefined ? undefined : byId.get(filter.eventId);
  const link = (p: { category?: string | undefined; status?: string | undefined }) => {
    const q = new URLSearchParams();
    if (p.category !== undefined) q.set('category', p.category);
    if (p.status !== undefined) q.set('status', p.status);
    const s = q.toString();
    return s === '' ? hub : `${hub}?${s}`;
  };
  const hidden = {
    slug,
    competitionId: c.id,
    ...(filter.eventId === undefined ? {} : { category: filter.eventId }),
    ...(filter.status === undefined ? {} : { status: filter.status }),
  };
  const canDecide = page.data.access.permissions.includes('COMP_MANAGE_REGISTRATIONS');

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={`/app/orgs/${slug}/tournaments`}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span>{' '}
        <span>Registrations</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="rg-console-head">
        <div>
          <span className="mono muted">{c.profile.name}</span>
          <h2 className="tb-h">
            Registrations <span className="tb-count">{total}</span>
          </h2>
        </div>
        {!canDecide ? (
          <p className="muted small">Your role can view entries but not decide on them.</p>
        ) : null}
      </header>

      <nav className="rg-filters" aria-label="Filter by status">
        <a
          className="rg-filter"
          href={link({ category: filter.eventId })}
          aria-current={filter.status === undefined ? 'true' : undefined}
        >
          <span>All</span>
          <strong>{total}</strong>
        </a>
        {REGISTRATION_STATUSES.map((s) => (
          <a
            key={s}
            className="rg-filter"
            data-status={s}
            href={link({ category: filter.eventId, status: s })}
            aria-current={filter.status === s ? 'true' : undefined}
          >
            <span>{REGISTRATION_STATUS_LABEL[s]}</span>
            <strong>{counts[s]}</strong>
          </a>
        ))}
      </nav>

      <div className="tb-layout rg-console">
        <section aria-labelledby="list-h" className="rg-main">
          <h3 id="list-h" className="sr-only">
            Entries
          </h3>
          {items.length === 0 ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>
                {total === 0 ? 'No registrations yet' : 'No registrations match this filter'}
              </strong>
              <p className="muted">
                {total === 0
                  ? events.some((e) => e.status === 'REGISTRATION_OPEN')
                    ? 'Entries appear here as athletes register.'
                    : 'Open registration on a category to start taking entries.'
                  : 'Try another status or category.'}
              </p>
            </div>
          ) : (
            <ol className="rg-board">
              {items.map((r) => (
                <Row
                  key={r.id}
                  r={r}
                  event={byId.get(r.event.id)}
                  detail={`${hub}/${r.id}`}
                  hidden={hidden}
                  showCategory={selected === undefined}
                />
              ))}
            </ol>
          )}
          {nextCursor !== null ? (
            <a
              className="btn btn-ghost btn-sm rg-more"
              href={`${link({ category: filter.eventId, status: filter.status })}${
                filter.eventId === undefined && filter.status === undefined ? '?' : '&'
              }after=${nextCursor}`}
            >
              Next entries →
            </a>
          ) : null}
          {filter.after !== undefined ? (
            <a
              className="link mono small"
              href={link({ category: filter.eventId, status: filter.status })}
            >
              ← Back to the first entries
            </a>
          ) : null}
        </section>

        <aside className="tb-side">
          <section className="tb-panel" aria-labelledby="cat-h">
            <h3 id="cat-h" className="mono muted">
              Categories
            </h3>
            <ul className="rg-cats">
              <li>
                <a
                  href={link({ status: filter.status })}
                  aria-current={selected === undefined ? 'true' : undefined}
                >
                  <strong>All categories</strong>
                </a>
              </li>
              {events.map((e) => (
                <li key={e.id}>
                  <a
                    href={link({ category: e.id, status: filter.status })}
                    aria-current={selected?.id === e.id ? 'true' : undefined}
                  >
                    <SportGlyph
                      code={e.discipline.sport.code}
                      name={e.discipline.sport.name}
                      size={28}
                    />
                    <span className="rg-cat-text">
                      <strong>{e.settings.name}</strong>
                      <span className="mono muted">
                        {e.counts.confirmed}
                        {e.settings.capacity === null ? '' : `/${e.settings.capacity}`} confirmed
                        {e.counts.waitlisted > 0 ? ` · ${e.counts.waitlisted} wait` : ''}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
          {selected !== undefined ? <CategoryPanel e={selected} base={base} /> : null}
        </aside>
      </div>
    </>
  );
}

function Row({
  r,
  event,
  detail,
  hidden,
  showCategory,
}: {
  r: Registration;
  event: ManagedEvent | undefined;
  detail: string;
  hidden: Record<string, string>;
  showCategory: boolean;
}) {
  const keys = Object.fromEntries(
    ['CONFIRM', 'WAITLIST', 'DECLINE', 'CANCEL', 'WITHDRAW'].map((k) => [
      k,
      `oc-dec-${randomUUID()}`,
    ]),
  );
  return (
    <li className="rg-item" data-status={r.status}>
      <div className="rg-item-who">
        <EntrantIdentity r={r} />
      </div>
      {showCategory ? (
        <div className="rg-item-cat">
          <span className="mono muted">Category</span>
          <span>{r.event.name}</span>
        </div>
      ) : null}
      <div className="rg-item-status">
        <RegistrationStatusChip status={r.status} />
        <span className="mono muted rg-when">
          {dateTime(r.requestedAt, r.event.timezone) ?? r.requestedAt}
        </span>
      </div>
      <div className="rg-item-actions">
        <DecisionForms
          r={r}
          action={registrationDecisionAction}
          hidden={hidden}
          keys={keys}
          compact
          full={categoryLooksFull(event)}
        />
        <a className="link mono small" href={detail}>
          Details →
        </a>
      </div>
      {r.reason !== null ? <q className="rg-reason rg-item-reason">{r.reason}</q> : null}
    </li>
  );
}

function CategoryPanel({ e, base }: { e: ManagedEvent; base: string }) {
  const cap = e.settings.capacity;
  const fill = cap === null ? null : Math.min(100, Math.round((e.counts.confirmed / cap) * 100));
  return (
    <section className="tb-panel" aria-labelledby="sel-h">
      <h3 id="sel-h" className="mono muted">
        {e.settings.name}
      </h3>
      <StatusBadge status={e.status} />
      <div className="tb-capacity">
        <span className="mono muted">
          {e.counts.confirmed} confirmed
          {e.counts.waitlisted > 0 ? ` · ${e.counts.waitlisted} waitlisted` : ''}
        </span>
        <span className="mono">{cap === null ? 'No cap' : `of ${cap}`}</span>
        {fill !== null ? (
          <span className="tb-meter" aria-hidden="true">
            <span style={{ width: `${fill}%` }} />
          </span>
        ) : null}
      </div>
      <p className="muted small">
        {e.settings.registrationMode === 'ORGANIZER_APPROVAL'
          ? 'Approval: every entry waits for your decision.'
          : 'Auto-confirm: entries are confirmed while places last, then waitlisted.'}
        {e.entrantKind === 'TEAM' ? ' Team category.' : ''}
      </p>
      <a className="btn btn-ghost btn-sm" href={`${base}/categories/${e.id}`}>
        Category settings
      </a>
    </section>
  );
}
