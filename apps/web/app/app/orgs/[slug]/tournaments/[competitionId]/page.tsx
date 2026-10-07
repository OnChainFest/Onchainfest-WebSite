import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../_lib/search-params';
import {
  COMPETITION_COMMANDS,
  COMPETITION_STATUS_LABEL,
  COMPETITION_TRACK,
  builderSteps,
  categoryChips,
  dateRange,
  dateTime,
  offeredTransitions,
  reviewChecklist,
} from '../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../_lib/tournament-context';
import type { ManagedEvent } from '../../../../../_lib/tournaments';
import { Flash } from '../../../../../_product/flash';
import { SubmitButton } from '../../../../../_product/submit-button';
import {
  BuilderRail,
  CancelForm,
  Fact,
  SportGlyph,
  StatusBadge,
  StatusTrack,
  TournamentArt,
} from '../../../../../_product/tournament-ui';
import { tournamentTransitionAction } from '../actions';

export const metadata = { title: 'Tournament builder · OnChainFest' };

/**
 * The Tournament Builder for one tournament. Everything it offers comes from
 * GET /v1/competitions/:id/manage: `editable` decides which edits appear, `nextStatuses` (with the
 * caller's competition permissions) decides which lifecycle buttons appear.
 */
export default async function TournamentBuilderPage({
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
  const hub = `/app/orgs/${slug}/tournaments`;
  if (t.kind === 'unavailable')
    return (
      <div className="state-block bad">
        <strong>This tournament can’t be loaded right now.</strong>
        <p className="muted">Nothing was lost. Try again in a moment.</p>
      </div>
    );

  const { competition: c, events, access } = t.data;
  const p = c.profile;
  const base = `${hub}/${c.id}`;
  const perms = access.permissions;
  const canEdit = perms.includes('COMP_EDIT');
  const transitions = offeredTransitions(c.nextStatuses, COMPETITION_COMMANDS, perms);
  const forward = transitions.filter((x) => x.status !== 'CANCELLED');
  const cancel = transitions.find((x) => x.status === 'CANCELLED');
  const review = reviewChecklist(t.data);
  const ordered = [
    ...events.filter((e) => e.status !== 'CANCELLED'),
    ...events.filter((e) => e.status === 'CANCELLED'),
  ];
  const when = dateRange(p.startsAt, p.endsAt, p.timezone);
  const hidden = { slug, competitionId: c.id };

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span> <span>{p.name}</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="tb-hero" data-status={c.status}>
        <TournamentArt startsAt={p.startsAt} timezone={p.timezone} status={c.status} size="hero" />
        <div className="tb-hero-body">
          <h2 className="tb-hero-title">{p.name}</h2>
          <div className="tb-facts">
            <Fact label="Dates">{when ?? 'Not set'}</Fact>
            <Fact label="Venue">
              {[p.locationLabel, p.regionCode].filter(Boolean).join(' · ') || 'Not set'}
            </Fact>
            <Fact label="Timezone">{p.timezone.replaceAll('_', ' ')}</Fact>
            <Fact label="Address">
              /competitions/
              <wbr />
              {c.slug}
            </Fact>
          </div>
          <div className="tb-hero-actions">
            {c.editable.profile && canEdit ? (
              <a className="btn btn-ghost btn-sm" href={`${base}/edit`}>
                Edit details
              </a>
            ) : null}
            {c.status !== 'DRAFT' ? (
              <a className="btn btn-ghost btn-sm" href={`/competitions/${c.slug}`}>
                Public page ↗
              </a>
            ) : null}
          </div>
        </div>
      </header>

      {c.status === 'DRAFT' ? <BuilderRail steps={builderSteps(t.data, base)} /> : null}

      <div className="tb-layout">
        <section id="categories" aria-labelledby="cat-h" className="tb-main">
          <div className="section-head">
            <h3 id="cat-h" className="tb-h3">
              Categories <span className="tb-count">{ordered.length}</span>
            </h3>
            {c.editable.addEvents && canEdit ? (
              <a className="btn btn-cyan btn-sm" href={`${base}/categories/new`}>
                + Add category
              </a>
            ) : null}
          </div>
          {ordered.length === 0 ? (
            c.editable.addEvents && canEdit ? (
              <a className="tb-slot" href={`${base}/categories/new`}>
                <span className="tb-plus" aria-hidden="true">
                  +
                </span>
                <strong>Add your first category</strong>
                <span className="muted small">Sport · discipline · entrants · format</span>
              </a>
            ) : (
              <div className="empty">
                <span className="empty-mark" aria-hidden="true" />
                <strong>No categories</strong>
              </div>
            )
          ) : (
            <ul className="tb-cats">
              {ordered.map((e) => (
                <CategoryCard key={e.id} e={e} href={`${base}/categories/${e.id}`} />
              ))}
            </ul>
          )}
        </section>

        <aside className="tb-side">
          {c.status === 'DRAFT' ? (
            <section id="review" aria-labelledby="rev-h" className="tb-panel">
              <h3 id="rev-h" className="mono muted">
                Review
              </h3>
              <ul className="tb-check">
                {review.map((r) => (
                  <li key={r.key} data-done={r.done}>
                    <span aria-hidden="true">{r.done ? '✓' : '!'}</span>
                    {r.label}
                    <span className="sr-only">{r.done ? ' — done' : ' — to do'}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section id="publish" aria-labelledby="pub-h" className="tb-panel">
            <h3 id="pub-h" className="mono muted">
              {c.status === 'DRAFT' ? 'Publish' : 'Lifecycle'}
            </h3>
            <StatusTrack
              track={COMPETITION_TRACK}
              status={c.status}
              labels={COMPETITION_STATUS_LABEL}
            />
            {forward.length > 0 || cancel !== undefined ? (
              <div className="tb-actions">
                {forward.map((x, i) => (
                  <form key={x.command} action={tournamentTransitionAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="competitionId" value={c.id} />
                    <input type="hidden" name="command" value={x.command} />
                    <SubmitButton
                      pending="Working"
                      className={i === 0 ? 'btn btn-cyan btn-full' : 'btn btn-ghost btn-full'}
                    >
                      {x.label}
                    </SubmitButton>
                  </form>
                ))}
                {cancel !== undefined ? (
                  <CancelForm
                    action={tournamentTransitionAction}
                    hidden={hidden}
                    label={cancel.label}
                  />
                ) : null}
              </div>
            ) : (
              <p className="muted small">
                {c.nextStatuses.length === 0
                  ? `This tournament is ${COMPETITION_STATUS_LABEL[c.status].toLowerCase()}.`
                  : 'Your role can’t change this tournament’s status.'}
              </p>
            )}
          </section>
        </aside>
      </div>

      {forward[0] !== undefined ? (
        <div className="tb-dock">
          <span className="mono">{COMPETITION_STATUS_LABEL[c.status]}</span>
          <a className="btn btn-cyan btn-sm" href="#publish">
            {forward[0].label}
          </a>
        </div>
      ) : null}
    </>
  );
}

function CategoryCard({ e, href }: { e: ManagedEvent; href: string }) {
  const s = e.settings;
  const chips = categoryChips(s.category);
  const opens = dateTime(s.registrationOpensAt, s.timezone);
  const closes = dateTime(s.registrationClosesAt, s.timezone);
  const fill =
    s.capacity === null ? null : Math.min(100, Math.round((e.counts.confirmed / s.capacity) * 100));
  return (
    <li>
      <a className="tb-cat" href={href} data-status={e.status}>
        <span className="tb-cat-head">
          <SportGlyph code={e.discipline.sport.code} name={e.discipline.sport.name} />
          <span className="tb-cat-id">
            <strong>{s.name}</strong>
            <span className="muted small">
              {e.discipline.sport.name} · {e.discipline.name}
            </span>
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
        <span className="tb-cat-grid">
          <Fact label="Format">{e.format.name}</Fact>
          <Fact label="Entrants">{e.entrantKind === 'TEAM' ? 'Teams' : 'Individual'}</Fact>
          <Fact label="Registration">
            {s.registrationMode === 'ORGANIZER_APPROVAL' ? 'Approval' : 'Auto-confirm'}
          </Fact>
          <Fact label="Window">
            {opens !== null || closes !== null ? `${opens ?? '…'} → ${closes ?? '…'}` : 'Not set'}
          </Fact>
        </span>
        <span className="tb-capacity">
          <span className="mono muted">
            {e.counts.confirmed} confirmed
            {e.counts.waitlisted > 0 ? ` · ${e.counts.waitlisted} waitlisted` : ''}
          </span>
          <span className="mono">{s.capacity === null ? 'No cap' : `of ${s.capacity}`}</span>
          {fill !== null ? (
            <span className="tb-meter" aria-hidden="true">
              <span style={{ width: `${fill}%` }} />
            </span>
          ) : null}
        </span>
        <span className="tb-cat-foot">
          <StatusBadge status={e.status} />
          <span className="link mono small">{e.editable.settings ? 'Configure' : 'View'} →</span>
        </span>
      </a>
    </li>
  );
}
