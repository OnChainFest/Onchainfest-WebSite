import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../../../_lib/org-context';
import { one, type SearchParams } from '../../../../../../../_lib/search-params';
import {
  EVENT_COMMANDS,
  EVENT_STATUS_LABEL,
  EVENT_TRACK,
  categoryChips,
  dateTime,
  offeredTransitions,
  timeZones,
} from '../../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../../_lib/tournament-context';
import { CategorySettingsFields } from '../../../../../../../_product/category-fields';
import { Flash } from '../../../../../../../_product/flash';
import { SubmitButton } from '../../../../../../../_product/submit-button';
import {
  CancelForm,
  Fact,
  SportGlyph,
  StatusBadge,
  StatusTrack,
} from '../../../../../../../_product/tournament-ui';
import { categoryTransitionAction, updateCategoryAction } from '../../../actions';

export const metadata = { title: 'Category · OnChainFest' };

/**
 * One category: its settings (while `editable.settings`; capacity and entry mode only while
 * `editable.capacityAndRegistrationMode`) and its lifecycle (from the event's `nextStatuses`).
 * Discipline, format and entrant kind are fixed at creation and shown, never offered.
 */
export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; competitionId: string; eventId: string }>;
  searchParams: SearchParams;
}) {
  const [{ slug, competitionId, eventId }, query] = await Promise.all([params, searchParams]);
  const org = await orgContext(slug);
  if (org.kind !== 'ok') notFound();
  const t = await tournamentFor(org.ctx, competitionId);
  if (t.kind === 'not_found') notFound();
  if (t.kind === 'unavailable')
    return (
      <div className="state-block bad">
        <strong>This category can’t be loaded right now.</strong>
      </div>
    );
  const e = t.data.events.find((x) => x.id === eventId);
  if (e === undefined) notFound();
  const { competition: c, access } = t.data;
  const perms = access.permissions;
  const hub = `/app/orgs/${slug}/tournaments`;
  const base = `${hub}/${c.id}`;
  const s = e.settings;
  const canEdit = e.editable.settings && perms.includes('COMP_EDIT');
  const transitions = offeredTransitions(e.nextStatuses, EVENT_COMMANDS, perms);
  const forward = transitions.filter((x) => x.status !== 'CANCELLED');
  const cancel = transitions.find((x) => x.status === 'CANCELLED');
  const chips = categoryChips(s.category);
  const fill =
    s.capacity === null ? null : Math.min(100, Math.round((e.counts.confirmed / s.capacity) * 100));

  return (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span> <span>{s.name}</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />

      <header className="tb-cat-hero" data-status={e.status}>
        <SportGlyph code={e.discipline.sport.code} name={e.discipline.sport.name} size={72} />
        <div className="tb-cat-hero-id">
          <span className="mono muted">
            {e.discipline.sport.name} · {e.discipline.name}
          </span>
          <h2 className="tb-hero-title">{s.name}</h2>
          <span className="tb-chips">
            <span className="chip mono">{e.format.name}</span>
            <span className="chip mono">{e.entrantKind === 'TEAM' ? 'Teams' : 'Individual'}</span>
            {chips.map((x) => (
              <span key={x} className="chip mono">
                {x}
              </span>
            ))}
          </span>
        </div>
        <StatusBadge status={e.status} />
      </header>

      <div className="tb-layout tb-layout-ops">
        <section className="tb-main" aria-labelledby="set-h">
          <h3 id="set-h" className="sr-only">
            Settings
          </h3>
          {canEdit ? (
            <form action={updateCategoryAction} className="tb-form">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="competitionId" value={c.id} />
              <input type="hidden" name="eventId" value={e.id} />
              <CategorySettingsFields
                settings={s}
                capacityEditable={e.editable.capacityAndRegistrationMode}
                zones={timeZones()}
                competitionTz={c.profile.timezone}
              />
              <div className="tb-form-foot">
                <SubmitButton pending="Saving" className="btn btn-cyan">
                  Save category
                </SubmitButton>
                <a className="btn btn-ghost" href={base}>
                  Back to builder
                </a>
              </div>
            </form>
          ) : (
            <div className="tb-form">
              <p className="tb-locked mono">
                {e.editable.settings
                  ? 'Your role can’t edit this category'
                  : 'Settings are locked for this category'}
              </p>
              <div className="tb-facts tb-facts-col">
                <Fact label="Capacity">{s.capacity ?? 'No cap'}</Fact>
                <Fact label="Entries">
                  {s.registrationMode === 'ORGANIZER_APPROVAL' ? 'Approval' : 'Auto-confirm'}
                </Fact>
                <Fact label="Registration">
                  {dateTime(s.registrationOpensAt, s.timezone) ?? '…'} →{' '}
                  {dateTime(s.registrationClosesAt, s.timezone) ?? '…'}
                </Fact>
                <Fact label="Play">
                  {dateTime(s.startsAt, s.timezone) ?? '…'} →{' '}
                  {dateTime(s.endsAt, s.timezone) ?? '…'}
                </Fact>
                <Fact label="Timezone">{s.timezone}</Fact>
              </div>
              <a className="btn btn-ghost" href={base}>
                Back to builder
              </a>
            </div>
          )}
        </section>

        <aside className="tb-side">
          <section className="tb-panel" aria-labelledby="fld-h">
            <h3 id="fld-h" className="mono muted">
              Field
            </h3>
            <div className="tb-field-count">
              <strong>{e.counts.confirmed}</strong>
              <span className="mono muted">
                {s.capacity === null ? 'confirmed · no cap' : `of ${s.capacity} confirmed`}
              </span>
            </div>
            {fill !== null ? (
              <span className="tb-meter" aria-hidden="true">
                <span style={{ width: `${fill}%` }} />
              </span>
            ) : null}
            {e.counts.waitlisted > 0 ? (
              <span className="mono muted small">{e.counts.waitlisted} waitlisted</span>
            ) : null}
            <a className="btn btn-ghost btn-sm" href={`${base}/registrations?category=${e.id}`}>
              Manage entries →
            </a>
          </section>
          <section className="tb-panel" aria-labelledby="lc-h">
            <h3 id="lc-h" className="mono muted">
              Lifecycle
            </h3>
            <StatusTrack track={EVENT_TRACK} status={e.status} labels={EVENT_STATUS_LABEL} />
            {forward.length > 0 || cancel !== undefined ? (
              <div className="tb-actions">
                {forward.map((x, i) => (
                  <form key={x.command} action={categoryTransitionAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="competitionId" value={c.id} />
                    <input type="hidden" name="eventId" value={e.id} />
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
                    action={categoryTransitionAction}
                    hidden={{ slug, competitionId: c.id, eventId: e.id }}
                    label={cancel.label}
                  />
                ) : null}
              </div>
            ) : (
              <p className="muted small">
                {e.nextStatuses.length === 0
                  ? `This category is ${EVENT_STATUS_LABEL[e.status].toLowerCase()}.`
                  : e.nextStatuses.some((n) => EVENT_COMMANDS[n] !== undefined)
                    ? 'Your role can’t change this category’s status.'
                    : 'Next steps happen in competition operations.'}
              </p>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
