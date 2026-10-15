import { notFound } from 'next/navigation';
import { orgContext } from '../../../../../../_lib/org-context';
import {
  addDays,
  canManageResources,
  categoryResourceTypes,
  competitionAvailability,
  competitionResources,
  dayStart,
  effectiveAvailability,
  isResourceType,
  layersOf,
  offeredTypes,
  previewAnchor,
  previewDays,
  readinessOf,
  READINESS_LABEL,
  resourcesClosed,
  resourceSummary,
  typeLabel,
  weeklyLine,
  type PreviewDay,
  type ResourceView,
} from '../../../../../../_lib/resources';
import { one, type SearchParams } from '../../../../../../_lib/search-params';
import { timeZones, validTimeZone } from '../../../../../../_lib/tournament-builder';
import { tournamentFor } from '../../../../../../_lib/tournament-context';
import { tournamentCatalog } from '../../../../../../_lib/tournaments';
import { CompetitionNav } from '../../../../../../_product/competition-hub-ui';
import { Flash } from '../../../../../../_product/flash';
import {
  AddHours,
  HoursList,
  Preview,
  ReadinessChip,
  ReadinessPanel,
  ResourceFacts,
  ResourceForm,
  StatusForm,
  type Hidden,
} from '../../../../../../_product/resources-ui';
import {
  addAvailabilityAction,
  createResourceAction,
  replaceAvailabilityAction,
  resourceStatusAction,
  revokeAvailabilityAction,
  updateResourceAction,
} from './actions';

export const metadata = { title: 'Tournament resources · OnChainFest' };

/**
 * ONCF-L2 resources and availability. Everything shown comes from the ONCF-05E-A API: the
 * resources (GET /competitions/:id/resources), their declared hours (GET …/availability) and, per
 * active resource, the effective intervals for seven days (GET /resources/:id/availability). Changes
 * are offered with COMP_EDIT on an open competition; the API checks both again. Readiness mirrors
 * scheduling: a resource without declared hours (its own or tournament-wide) is never used.
 */
export default async function TournamentResourcesPage({
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

  const { competition: c, access, events } = t.data;
  const base = `${hub}/${c.id}`;
  const token = org.ctx.accessToken;
  const [resources, facts, catalog] = await Promise.all([
    competitionResources(token, c.id),
    competitionAvailability(token, c.id),
    tournamentCatalog(),
  ]);
  const manage = canManageResources(access.permissions) && !resourcesClosed(c.status);
  const hidden: Hidden = { slug, competitionId: c.id };
  const competitionZone = c.profile.timezone;
  const needs = categoryResourceTypes(events, catalog.kind === 'ok' ? catalog.data : null);
  const offered = offeredTypes(needs);
  const adding = one(query.add);
  const addType = adding !== undefined && offered.types.includes(adding as never) ? adding : null;

  const head = (
    <>
      <nav className="tb-crumbs mono" aria-label="Breadcrumb">
        <a href={hub}>Tournaments</a> <span aria-hidden="true">/</span>{' '}
        <a href={base}>{c.profile.name}</a> <span aria-hidden="true">/</span> <span>Resources</span>
      </nav>
      <Flash error={one(query.error)} notice={one(query.notice)} />
      <CompetitionNav data={t.data} base={base} current="resources" />
      <header className="rg-console-head">
        <div>
          <span className="mono muted">{c.profile.name}</span>
          <h2 className="tb-h">Resources</h2>
          <p className="muted small">
            Where matches can be played, and when each place can be used.
          </p>
        </div>
      </header>
    </>
  );

  if (resources.kind !== 'ok' || facts.kind !== 'ok')
    return (
      <>
        {head}
        <div className="state-block bad">
          <strong>Resources can’t be loaded right now.</strong>
          <p className="muted">
            Nothing was changed. Try again in a moment, or go back to the{' '}
            <a href={base}>tournament overview</a>.
          </p>
        </div>
      </>
    );

  const all = resources.data.items;
  const allFacts = facts.data.items;
  const active = all.filter((r) => r.status === 'ACTIVE');
  const retired = all.filter((r) => r.status === 'RETIRED');
  const summary = resourceSummary(all, allFacts, needs);
  const zoneOf = (r: ResourceView) =>
    r.timezone !== null && validTimeZone(r.timezone) ? r.timezone : competitionZone;

  // Seven days of effective availability per active resource, from the tournament's first day.
  const anchor = previewAnchor(c.profile.startsAt, competitionZone, Date.now());
  const previewHeading = c.profile.startsAt !== null ? 'Tournament’s first 7 days' : 'Next 7 days';
  const previews = new Map<string, PreviewDay[] | null>(
    await Promise.all(
      active.map(async (r): Promise<[string, PreviewDay[] | null]> => {
        const zone = zoneOf(r);
        const from = dayStart(anchor, zone);
        const to = dayStart(addDays(anchor, 7), zone);
        if (from === null || to === null) return [r.resourceId, null];
        const e = await effectiveAvailability(token, r.resourceId, from, to);
        return [r.resourceId, e.kind === 'ok' ? previewDays(e.data.intervals, anchor, zone) : null];
      }),
    ),
  );
  const competitionLayer = allFacts.filter((f) => f.resourceId === null);
  const byType = [...new Set(active.map((r) => r.typeCode))].map((type) => ({
    type,
    items: active.filter((r) => r.typeCode === type),
  }));

  const item = (r: ResourceView) => {
    const zone = zoneOf(r);
    const { own, competition } = layersOf(allFacts, r.resourceId);
    const readiness = readinessOf(r, allFacts);
    const line = weeklyLine(own);
    return (
      <li key={r.resourceId} data-readiness={readiness}>
        <details className="res-item">
          <summary>
            <span className="res-item-id">
              <strong>{r.label}</strong>
              <span className="muted small">
                {typeLabel(r.typeCode)}
                {r.locationLabel !== null ? ` · ${r.locationLabel}` : ''}
              </span>
            </span>
            <span className="res-item-hours small">
              {line ??
                (readiness === 'ready' && competition.length > 0
                  ? 'Tournament-wide hours apply'
                  : readiness === 'ready'
                    ? 'Special opening hours only'
                    : readiness === 'retired'
                      ? 'Retired'
                      : 'No hours declared')}
            </span>
            <ReadinessChip readiness={readiness} />
          </summary>
          <div className="res-item-body">
            {readiness === 'no-hours' ? (
              <p className="res-warn" role="note">
                <strong>No declared hours.</strong> {READINESS_LABEL['no-hours'].detail} Add weekly
                or special opening hours below, or declare tournament-wide hours.
              </p>
            ) : null}
            <ResourceFacts resource={r} zone={zone} inherited={r.timezone === null} />
            <HoursList
              facts={own}
              zone={zone}
              manage={manage}
              hidden={hidden}
              resourceId={r.resourceId}
              revoke={revokeAvailabilityAction}
              replace={replaceAvailabilityAction}
            />
            {r.status === 'ACTIVE' ? (
              <Preview
                days={previews.get(r.resourceId) ?? null}
                zone={zone}
                heading={previewHeading}
              />
            ) : null}
            {manage ? (
              <div className="res-item-actions">
                {r.status === 'ACTIVE' ? (
                  <AddHours
                    hidden={hidden}
                    resourceId={r.resourceId}
                    zone={zone}
                    add={addAvailabilityAction}
                    idPrefix={`h-${r.resourceId.slice(0, 8)}`}
                  />
                ) : null}
                {isResourceType(r.typeCode) ? (
                  <details className="res-edit">
                    <summary className="btn btn-ghost btn-sm">Edit details</summary>
                    <ResourceForm
                      action={updateResourceAction}
                      hidden={hidden}
                      typeCode={r.typeCode}
                      resource={r}
                      competitionZone={competitionZone}
                      submit="Save details"
                    />
                  </details>
                ) : null}
                <StatusForm action={resourceStatusAction} hidden={hidden} resource={r} />
              </div>
            ) : null}
          </div>
        </details>
      </li>
    );
  };

  return (
    <>
      {head}
      <ReadinessPanel summary={summary} />

      <div className="tb-layout">
        <section aria-labelledby="res-h" className="tb-main">
          <section aria-labelledby="comp-hours-h" className="res-layer">
            <div className="section-head">
              <h3 id="comp-hours-h" className="tb-h3">
                Tournament-wide hours
              </h3>
            </div>
            <p className="muted small">
              Hours that apply to every resource. Each resource can be used only when both its own
              hours and these allow it — leave these empty to manage hours per resource.
            </p>
            <HoursList
              facts={competitionLayer}
              zone={competitionZone}
              manage={manage}
              hidden={hidden}
              resourceId={null}
              revoke={revokeAvailabilityAction}
              replace={replaceAvailabilityAction}
            />
            {manage ? (
              <AddHours
                hidden={hidden}
                resourceId={null}
                zone={competitionZone}
                add={addAvailabilityAction}
                idPrefix="h-comp"
              />
            ) : null}
          </section>

          <h3 id="res-h" className="tb-h3">
            Resources <span className="tb-count">{active.length}</span>
          </h3>
          {active.length === 0 ? (
            <div className="empty">
              <span className="empty-mark" aria-hidden="true" />
              <strong>No resources yet</strong>
              <span className="muted small">
                Add the courts, lanes, pools or courses this tournament will use, then declare when
                each one is open. Scheduling only uses resources with declared hours.
              </span>
            </div>
          ) : (
            byType.map((g) => (
              <section key={g.type} className="res-group" aria-label={typeLabel(g.type, 2)}>
                <h4 className="mono muted">
                  {typeLabel(g.type, g.items.length)} · {g.items.length}
                </h4>
                <ul className="res-list">{g.items.map(item)}</ul>
              </section>
            ))
          )}

          {retired.length > 0 ? (
            <details className="res-retired">
              <summary>
                Retired resources <span className="tb-count">{retired.length}</span>
              </summary>
              <ul className="res-list">{retired.map(item)}</ul>
            </details>
          ) : null}
        </section>

        <aside className="tb-side">
          {manage ? (
            <section id="add" aria-labelledby="add-h" className="tb-panel res-add">
              <h3 id="add-h" className="mono muted">
                Add a resource
              </h3>
              <div className="res-type-pick" role="list">
                {offered.types.map((type) => (
                  <a
                    key={type}
                    role="listitem"
                    className="chip mono"
                    href={`${base}/resources?add=${type}#add`}
                    aria-current={type === addType ? 'true' : undefined}
                  >
                    + {typeLabel(type)}
                  </a>
                ))}
              </div>
              <p className="muted small">
                {offered.restricted
                  ? 'Types your categories can be played on.'
                  : needs.length === 0 && events.length > 0 && catalog.kind !== 'ok'
                    ? 'The sport catalog is unavailable, so every type is offered.'
                    : 'Add a category to see only the types its sport uses.'}
              </p>
              {addType !== null && isResourceType(addType) ? (
                <ResourceForm
                  action={createResourceAction}
                  hidden={hidden}
                  typeCode={addType}
                  competitionZone={competitionZone}
                  submit={`Add ${typeLabel(addType).toLowerCase()}`}
                />
              ) : null}
            </section>
          ) : (
            <section className="tb-panel">
              <h3 className="mono muted">View only</h3>
              <p className="muted small">
                {resourcesClosed(c.status)
                  ? 'This tournament has ended, so its resources can’t change.'
                  : 'Only a tournament owner or admin can add resources or change their hours.'}
              </p>
            </section>
          )}

          <section aria-labelledby="how-h" className="tb-panel">
            <h3 id="how-h" className="mono muted">
              How hours work
            </h3>
            <dl className="staff-roles">
              <div>
                <dt>Weekly hours</dt>
                <dd className="muted small">The regular opening times, day by day.</dd>
              </div>
              <div>
                <dt>Special opening hours</dt>
                <dd className="muted small">Different hours on one date.</dd>
              </div>
              <div>
                <dt>Closed days</dt>
                <dd className="muted small">The whole date is closed.</dd>
              </div>
              <div>
                <dt>Maintenance &amp; blackouts</dt>
                <dd className="muted small">A period when it can’t be used, with a reason.</dd>
              </div>
            </dl>
            <p className="muted small">
              A resource with no hours declared — its own or tournament-wide — is never scheduled.
              Removing hours keeps a record; nothing is deleted.
            </p>
          </section>
        </aside>
      </div>

      {manage ? (
        <datalist id="res-zones">
          {timeZones().map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}
