import { notFound } from 'next/navigation';
import { orgContext } from '../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../_lib/search-params';
import { dateRange } from '../../../../_lib/tournament-builder';
import { tournamentsFor } from '../../../../_lib/tournament-context';
import type { CompetitionStatus, ManagedCompetitionCard } from '../../../../_lib/tournaments';
import { Flash } from '../../../../_product/flash';
import { TournamentArt } from '../../../../_product/tournament-ui';

export const metadata = { title: 'Tournaments · OnChainFest' };

const GROUPS: { key: string; label: string; statuses: CompetitionStatus[] }[] = [
  { key: 'live', label: 'Live & upcoming', statuses: ['ACTIVE', 'PUBLISHED'] },
  { key: 'drafts', label: 'Drafts', statuses: ['DRAFT'] },
  { key: 'past', label: 'Past', statuses: ['COMPLETED', 'CANCELLED'] },
];

/** Tournament Hub: every tournament of the organization, drafts included (ORG_MANAGE_COMPETITIONS). */
export default async function TournamentHub({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const result = await orgContext(slug);
  if (result.kind !== 'ok' || !result.ctx.permissions.has('ORG_MANAGE_COMPETITIONS')) notFound();
  const items = await tournamentsFor(result.ctx);
  const base = `/app/orgs/${slug}/tournaments`;

  return (
    <>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <div className="tb-hub-head">
        <div>
          <span className="mono muted">Tournament hub</span>
          <h2 className="tb-h">
            Tournaments{' '}
            {items !== null && items.length > 0 ? (
              <span className="tb-count">{items.length}</span>
            ) : null}
          </h2>
        </div>
        <a className="btn btn-cyan" href={`${base}/new`}>
          + Create tournament
        </a>
      </div>

      {items === null ? (
        <div className="state-block bad">
          <strong>Tournaments are unavailable right now.</strong>
          <p className="muted">Nothing was lost. Try again in a moment.</p>
        </div>
      ) : items.length === 0 ? (
        <section className="tb-first" aria-labelledby="first-h">
          <div className="tb-first-art" aria-hidden="true">
            <TournamentArt startsAt={null} timezone="UTC" status="DRAFT" />
          </div>
          <div className="tb-first-body">
            <h3 id="first-h">Build your first tournament</h3>
            <ol className="tb-mini-steps">
              <li>
                <span className="mono">01</span> Name, dates and venue
              </li>
              <li>
                <span className="mono">02</span> Categories and formats
              </li>
              <li>
                <span className="mono">03</span> Review and publish
              </li>
            </ol>
            <a className="btn btn-cyan" href={`${base}/new`}>
              + Create tournament
            </a>
          </div>
        </section>
      ) : (
        GROUPS.map((g) => {
          const list = items.filter((c) => g.statuses.includes(c.status));
          if (list.length === 0) return null;
          return (
            <section key={g.key} className="tb-group-section" aria-labelledby={`g-${g.key}`}>
              <h3 id={`g-${g.key}`} className="mono muted">
                {g.label} · {list.length}
              </h3>
              <ul className="tb-cards">
                {list.map((c) => (
                  <TournamentCard key={c.id} c={c} href={`${base}/${c.id}`} />
                ))}
                {g.key === 'drafts' ? (
                  <li>
                    <a className="tb-card tb-card-new" href={`${base}/new`}>
                      <span className="tb-plus" aria-hidden="true">
                        +
                      </span>
                      <strong>New tournament</strong>
                    </a>
                  </li>
                ) : null}
              </ul>
            </section>
          );
        })
      )}
    </>
  );
}

function TournamentCard({ c, href }: { c: ManagedCompetitionCard; href: string }) {
  const live = c.eventCount - c.cancelledEventCount;
  const when = dateRange(c.startsAt, c.endsAt, c.timezone);
  return (
    <li>
      <a className="tb-card" href={href} data-status={c.status}>
        <TournamentArt startsAt={c.startsAt} timezone={c.timezone} status={c.status} />
        <span className="tb-card-body">
          <strong className="tb-card-title">{c.name}</strong>
          <span className="tb-card-meta">
            <span>{when ?? 'Dates not set'}</span>
            <span className="muted">
              {[c.locationLabel, c.regionCode].filter(Boolean).join(' · ') || 'Venue not set'}
            </span>
            {c.cancelledEventCount > 0 ? (
              <span className="muted small">
                {c.cancelledEventCount} cancelled{' '}
                {c.cancelledEventCount === 1 ? 'category' : 'categories'}
              </span>
            ) : null}
          </span>
          <span className="tb-card-foot">
            <span className="tb-pill mono">
              {live} {live === 1 ? 'category' : 'categories'}
            </span>
            <span className="link mono small">
              {c.status === 'DRAFT' ? 'Continue' : 'Manage'} →
            </span>
          </span>
        </span>
      </a>
    </li>
  );
}
