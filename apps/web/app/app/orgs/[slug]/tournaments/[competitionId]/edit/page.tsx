import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import { dateRange } from '../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { Flash } from '../../../../../../_product/flash';
import { SubmitButton } from '../../../../../../_product/submit-button';
import { TournamentProfileFields } from '../../../../../../_product/tournament-profile-fields';
import { Fact, TournamentArt } from '../../../../../../_product/tournament-ui';
import { updateTournamentAction } from '../../actions';

export const metadata = { title: 'Tournament details · OnChainFest' };

/** Tournament identity. Editable only while the API reports `editable.profile` (non-terminal). */
export default async function EditTournamentPage({
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
  if (t.kind === 'unavailable')
    return (
      <div className="state-block bad">
        <strong>This tournament can’t be loaded right now.</strong>
      </div>
    );
  const { competition: c, access } = t.data;
  const p = c.profile;
  const hub = `/app/orgs/${slug}/tournaments`;
  const base = `${hub}/${c.id}`;
  const editable = c.editable.profile && access.permissions.includes('COMP_EDIT');

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span> <a href={base}>{p.name}</a>{' '}
        <span aria-hidden="true">/</span> <span>Details</span>
      </nav>
      <div className="tb-builder">
        {editable ? (
          <form action={updateTournamentAction} className="tb-form">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="competitionId" value={c.id} />
            <input type="hidden" name="currentAddress" value={c.slug} />
            <Flash error={one(query.error)} notice={one(query.notice)} />
            <TournamentProfileFields profile={p} address={c.slug} />
            <div className="tb-form-foot">
              <SubmitButton pending="Saving" className="btn btn-cyan">
                Save details
              </SubmitButton>
              <a className="btn btn-ghost" href={base}>
                Back to builder
              </a>
            </div>
          </form>
        ) : (
          <div className="tb-form">
            <Flash error={one(query.error)} notice={one(query.notice)} />
            <p className="tb-locked mono">
              {c.editable.profile
                ? 'Your role can’t edit this tournament'
                : 'Details are final for this tournament'}
            </p>
            <div className="tb-facts tb-facts-col">
              <Fact label="Name">{p.name}</Fact>
              <Fact label="Dates">{dateRange(p.startsAt, p.endsAt, p.timezone) ?? 'Not set'}</Fact>
              <Fact label="Venue">
                {[p.locationLabel, p.regionCode].filter(Boolean).join(' · ') || 'Not set'}
              </Fact>
              <Fact label="Timezone">{p.timezone}</Fact>
              <Fact label="Website">{p.website ?? '—'}</Fact>
              <Fact label="Description">{p.description ?? '—'}</Fact>
            </div>
            <a className="btn btn-ghost" href={base}>
              Back to builder
            </a>
          </div>
        )}
        <aside className="tb-aside" aria-label="Preview">
          <div className="tb-poster">
            <TournamentArt
              startsAt={p.startsAt}
              timezone={p.timezone}
              status={c.status}
              size="hero"
            />
            <div className="tb-poster-body">
              <span className="mono muted">{org.ctx.membership.displayName}</span>
              <strong>{p.name}</strong>
              <span className="muted small">
                {dateRange(p.startsAt, p.endsAt, p.timezone) ?? 'Dates not set'}
                {p.locationLabel ? ` · ${p.locationLabel}` : ''}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
