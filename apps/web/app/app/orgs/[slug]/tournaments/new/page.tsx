import { notFound } from 'next/navigation';
import { idempotencyKey } from '../../../../../_lib/onboarding-input';
import { orgContext } from '../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../_lib/search-params';
import { Flash } from '../../../../../_product/flash';
import { SubmitButton } from '../../../../../_product/submit-button';
import { TournamentProfileFields } from '../../../../../_product/tournament-profile-fields';
import { BuilderRail, TournamentArt } from '../../../../../_product/tournament-ui';
import { createTournamentAction } from '../actions';

export const metadata = { title: 'New tournament · OnChainFest' };

/** Step 1 of the builder: the tournament's identity. It is created as a DRAFT. */
export default async function NewTournamentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const result = await orgContext(slug);
  if (result.kind !== 'ok' || !result.ctx.permissions.has('ORG_MANAGE_COMPETITIONS')) notFound();
  const base = `/app/orgs/${slug}/tournaments`;

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={base}>Tournaments</a> <span aria-hidden="true">/</span> <span>New</span>
      </nav>
      <BuilderRail
        steps={[
          {
            key: 'identity',
            label: 'Identity',
            detail: 'Name · dates · venue',
            state: 'current',
            href: '#identity',
          },
          { key: 'categories', label: 'Categories', detail: 'Sports & formats', state: 'todo' },
          {
            key: 'configuration',
            label: 'Configuration',
            detail: 'Capacity · windows',
            state: 'todo',
          },
          { key: 'review', label: 'Review', detail: 'Checklist', state: 'todo' },
          { key: 'publish', label: 'Publish', detail: 'Go public', state: 'todo' },
        ]}
      />
      <div className="tb-builder">
        <form action={createTournamentAction} className="tb-form">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="key" value={idempotencyKey('')} />
          <Flash error={one(query.error)} notice={one(query.notice)} />
          <TournamentProfileFields regionDefault={result.ctx.profile?.profile.country ?? ''} />
          <div className="tb-form-foot">
            <SubmitButton pending="Creating" className="btn btn-cyan">
              Create draft →
            </SubmitButton>
            <a className="btn btn-ghost" href={base}>
              Cancel
            </a>
          </div>
        </form>
        <aside className="tb-aside" aria-label="Preview">
          <div className="tb-poster">
            <TournamentArt startsAt={null} timezone="UTC" status="DRAFT" size="hero" />
            <div className="tb-poster-body">
              <span className="mono muted">{result.ctx.membership.displayName}</span>
              <strong>Your tournament</strong>
              <span className="muted small">Drafts stay private until you publish.</span>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
