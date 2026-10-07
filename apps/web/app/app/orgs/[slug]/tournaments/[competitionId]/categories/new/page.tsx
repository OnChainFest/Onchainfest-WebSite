import { notFound, redirect } from 'next/navigation';
import { idempotencyKey } from '../../../../../../../_lib/onboarding-input';
import { orgContext } from '../../../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../../../_lib/search-params';
import { timeZones } from '../../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../../_lib/tournament-context';
import { tournamentCatalog } from '../../../../../../../_lib/tournaments';
import { CategoryBuilder } from '../../../../../../../_product/category-builder';
import { Flash } from '../../../../../../../_product/flash';
import { addCategoryAction } from '../../../actions';

export const metadata = { title: 'Add category · OnChainFest' };

/** Assemble a category from the published catalog. Only when the API reports `editable.addEvents`. */
export default async function AddCategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; competitionId: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug, competitionId }, query] = await Promise.all([params, searchParams]);
  const org = await orgContext(slug);
  if (org.kind !== 'ok') notFound();
  const [t, catalog] = await Promise.all([
    tournamentFor(org.ctx, competitionId),
    tournamentCatalog(),
  ]);
  if (t.kind === 'not_found') notFound();
  const hub = `/app/orgs/${slug}/tournaments`;
  const base = `${hub}/${competitionId}`;
  if (
    t.kind === 'ok' &&
    !(t.data.competition.editable.addEvents && t.data.access.permissions.includes('COMP_EDIT'))
  )
    redirect(`${base}?error=tournament_transition`);
  if (t.kind !== 'ok' || catalog.kind !== 'ok')
    return (
      <div className="state-block bad">
        <strong>The sport catalog can’t be loaded right now.</strong>
        <p className="muted">Nothing was lost. Try again in a moment.</p>
      </div>
    );
  const p = t.data.competition.profile;

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span> <a href={base}>{p.name}</a>{' '}
        <span aria-hidden="true">/</span> <span>New category</span>
      </nav>
      <div className="tb-page-head">
        <span className="mono muted">{p.name}</span>
        <h2 className="tb-h">Add a category</h2>
      </div>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <CategoryBuilder
        catalog={catalog.data}
        action={addCategoryAction}
        slug={slug}
        competitionId={competitionId}
        idemKey={idempotencyKey('')}
        competitionTz={p.timezone}
        zones={timeZones()}
        cancelHref={base}
      />
    </>
  );
}
