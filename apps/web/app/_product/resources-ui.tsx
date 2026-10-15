import type { ReactNode } from 'react';
import { idempotencyKey } from '../_lib/onboarding-input';
import {
  ATTRIBUTE_LABEL,
  attributeText,
  dateText,
  OCCUPANCY_LABEL,
  periodText,
  READINESS_LABEL,
  RESOURCE_TYPE_ATTRIBUTES,
  RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE,
  typeLabel,
  weeklySummary,
  WEEKDAYS,
  windowText,
  type AvailabilityFactView,
  type PreviewDay,
  type Readiness,
  type ResourceSummary,
  type ResourceType,
  type ResourceView,
} from '../_lib/resources';
import { SubmitButton } from './submit-button';

/** ONCF-L2 resources and availability presentation (server-safe, no client state). */

type Action = (form: FormData) => Promise<never>;

export interface Hidden {
  readonly slug: string;
  readonly competitionId: string;
}

function HiddenFields({ hidden, extra = {} }: { hidden: Hidden; extra?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="slug" value={hidden.slug} />
      <input type="hidden" name="competitionId" value={hidden.competitionId} />
      <input type="hidden" name="key" value={idempotencyKey('')} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

const READY_MARK: Record<Readiness, string> = { ready: '✓', 'no-hours': '!', retired: '–' };

export function ReadinessChip({ readiness }: { readiness: Readiness }) {
  return (
    <span className="res-ready mono" data-readiness={readiness}>
      <span aria-hidden="true">{READY_MARK[readiness]}</span>
      {READINESS_LABEL[readiness].label}
    </span>
  );
}

/** The page's first answer: which resources scheduling can use, and what to fix. */
export function ReadinessPanel({ summary }: { summary: ResourceSummary }) {
  const problems = summary.needHours.length + summary.missing.length;
  const headline =
    summary.active === 0
      ? 'No active resources yet'
      : problems === 0
        ? `All ${summary.active} active ${summary.active === 1 ? 'resource has' : 'resources have'} declared hours`
        : `${summary.ready} of ${summary.active} active ${summary.active === 1 ? 'resource has' : 'resources have'} declared hours`;
  return (
    <section
      className="res-summary"
      aria-labelledby="res-sum-h"
      data-state={summary.active > 0 && problems === 0 ? 'ready' : 'attention'}
    >
      <span className="mono muted">Scheduling readiness</span>
      <strong id="res-sum-h">{headline}</strong>
      <ul className="res-counts" aria-label="Resource counts">
        <li>
          <strong>{summary.active}</strong> active
        </li>
        <li data-warn={summary.needHours.length > 0}>
          <strong>{summary.needHours.length}</strong> without hours
        </li>
        <li>
          <strong>{summary.retired}</strong> retired
        </li>
      </ul>
      {problems > 0 ? (
        <ul className="res-problems">
          {summary.needHours.length > 0 ? (
            <li>
              <strong>No declared hours:</strong> {summary.needHours.join(', ')}. Scheduling won’t
              use {summary.needHours.length === 1 ? 'it' : 'them'} until hours are declared — on the
              resource, or as tournament-wide hours.
            </li>
          ) : null}
          {summary.missing.map((m) => (
            <li key={m.category}>
              <strong>{m.category}:</strong> no active{' '}
              {m.types.map((t) => typeLabel(t, 2).toLowerCase()).join(' or ')} yet.
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted small">
        Resources are one part of scheduling. Matches also need category dates and a scheduling
        profile, which come with the schedule.
      </p>
    </section>
  );
}

/** Declared hours of one layer, by kind — weekly, special openings, closed days, maintenance. */
export function HoursList({
  facts,
  zone,
  manage,
  hidden,
  resourceId,
  revoke,
  replace,
}: {
  facts: readonly AvailabilityFactView[];
  zone: string;
  manage: boolean;
  hidden: Hidden;
  resourceId: string | null;
  revoke: Action;
  replace: Action;
}) {
  const weekly = [...facts.filter((f) => f.kind === 'WEEKLY')].sort(
    (a, b) => (a.weekday ?? 0) - (b.weekday ?? 0) || (a.start ?? '').localeCompare(b.start ?? ''),
  );
  const opens = facts.filter((f) => f.kind === 'DATE_OPEN');
  const closed = facts.filter((f) => f.kind === 'DATE_CLOSED');
  const periods = facts.filter((f) => f.kind === 'BLACKOUT' || f.kind === 'MAINTENANCE');
  const rows = weeklySummary(facts);
  const tools = (f: AvailabilityFactView, changeable: boolean) =>
    manage ? (
      <FactTools
        fact={f}
        hidden={hidden}
        resourceId={resourceId}
        revoke={revoke}
        replace={changeable ? replace : undefined}
      />
    ) : null;
  return (
    <div className="res-hours">
      <div className="res-hours-group" data-kind="weekly">
        <h5 className="mono muted">Weekly hours</h5>
        {rows.length === 0 ? (
          <p className="muted small">None declared.</p>
        ) : (
          <dl className="res-week">
            {rows.map((r) => (
              <div key={`${r.days}${r.validity ?? ''}`}>
                <dt>{r.days}</dt>
                <dd>
                  {r.windows.join(', ')}
                  {r.validity !== null ? (
                    <span className="muted small"> · {r.validity}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {manage && weekly.length > 0 ? (
          <details className="res-facts">
            <summary className="small">Change or remove weekly hours</summary>
            <ul>
              {weekly.map((f) => (
                <li key={f.availabilityId}>
                  <span>
                    {WEEKDAYS[(f.weekday ?? 1) - 1]?.long} {windowText(f.start ?? '', f.end ?? '')}
                  </span>
                  {tools(f, true)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {opens.length > 0 ? (
        <div className="res-hours-group" data-kind="open">
          <h5 className="mono muted">Special opening hours</h5>
          <ul className="res-dated">
            {opens.map((f) => (
              <li key={f.availabilityId}>
                <span>
                  <strong>{dateText(f.date ?? '')}</strong> · open{' '}
                  {windowText(f.start ?? '', f.end ?? '')}
                  <span className="muted small"> · replaces that day’s weekly hours</span>
                </span>
                {tools(f, true)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {closed.length > 0 ? (
        <div className="res-hours-group" data-kind="closed">
          <h5 className="mono muted">Closed days</h5>
          <ul className="res-dated">
            {closed.map((f) => (
              <li key={f.availabilityId} data-closed="true">
                <span>
                  <strong>{dateText(f.date ?? '')}</strong> ·{' '}
                  <span className="res-closed">Closed</span>
                </span>
                {tools(f, false)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {periods.length > 0 ? (
        <div className="res-hours-group" data-kind="periods">
          <h5 className="mono muted">Maintenance &amp; blackouts</h5>
          <ul className="res-dated">
            {periods.map((f) => (
              <li key={f.availabilityId}>
                <span>
                  <span className="chip mono">
                    {f.kind === 'MAINTENANCE' ? 'Maintenance' : 'Blackout'}
                  </span>{' '}
                  <strong>{periodText(f.startsAt ?? '', f.endsAt ?? '', zone)}</strong>
                  <span className="muted small"> · {f.reason}</span>
                </span>
                {tools(f, false)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Remove (revoke with a reason) and, for windows, change = remove + add again (not atomic). */
function FactTools({
  fact,
  hidden,
  resourceId,
  revoke,
  replace,
}: {
  fact: AvailabilityFactView;
  hidden: Hidden;
  resourceId: string | null;
  revoke: Action;
  replace: Action | undefined;
}) {
  const extra = { availabilityId: fact.availabilityId, resourceId: resourceId ?? '' };
  return (
    <span className="row-actions">
      {replace !== undefined ? (
        <details className="confirm">
          <summary className="btn btn-ghost btn-sm">Change</summary>
          <form action={replace} className="res-confirm">
            <HiddenFields
              hidden={hidden}
              extra={{
                ...extra,
                kind: fact.kind,
                ...(fact.kind === 'WEEKLY'
                  ? {
                      weekday: String(fact.weekday ?? ''),
                      validFrom: fact.validFrom ?? '',
                      validTo: fact.validTo ?? '',
                    }
                  : { date: fact.date ?? '' }),
              }}
            />
            <WindowFields start={fact.start ?? ''} end={fact.end ?? ''} />
            <ReasonField />
            <span className="muted small">
              The current hours are removed first, then the new ones are added.
            </span>
            <button className="btn btn-cyan btn-sm" type="submit">
              Save new hours
            </button>
          </form>
        </details>
      ) : null}
      <details className="confirm">
        <summary className="btn btn-ghost btn-sm">Remove</summary>
        <form action={revoke} className="res-confirm">
          <HiddenFields hidden={hidden} extra={extra} />
          <ReasonField />
          <button className="btn btn-danger btn-sm" type="submit">
            Confirm removal
          </button>
        </form>
      </details>
    </span>
  );
}

function ReasonField({ label = 'Reason · required' }: { label?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea name="reason" required minLength={1} maxLength={500} rows={2} />
    </label>
  );
}

/** Opening and closing time; 24:00 can't be typed into a time input, so it is a checkbox. */
function WindowFields({ start = '', end = '' }: { start?: string; end?: string }) {
  return (
    <div className="field-row res-window">
      <label className="field">
        <span>Opens</span>
        <input type="time" name="start" required defaultValue={start} step={60} />
      </label>
      <label className="field">
        <span>Closes</span>
        <input type="time" name="end" defaultValue={end === '24:00' ? '' : end} step={60} />
      </label>
      <label className="res-check small">
        <input type="checkbox" name="untilMidnight" defaultChecked={end === '24:00'} /> Until
        midnight
      </label>
      <small className="muted">A closing time before the opening time runs past midnight.</small>
    </div>
  );
}

/** The four ways to declare or restrict hours, each its own form. */
export function AddHours({
  hidden,
  resourceId,
  zone,
  add,
  idPrefix,
}: {
  hidden: Hidden;
  resourceId: string | null;
  zone: string;
  add: Action;
  idPrefix: string;
}) {
  const extra = { resourceId: resourceId ?? '' };
  return (
    <details className="res-add-hours">
      <summary className="btn btn-ghost btn-sm">+ Hours or closures</summary>
      <div className="res-forms">
        <form action={add} className="tb-form" aria-labelledby={`${idPrefix}-wk`}>
          <h5 id={`${idPrefix}-wk`} className="mono muted">
            Weekly hours
          </h5>
          <HiddenFields hidden={hidden} extra={{ ...extra, kind: 'WEEKLY' }} />
          <fieldset className="res-days">
            <legend className="small">Days</legend>
            {WEEKDAYS.map((d) => (
              <label key={d.n} className="res-day">
                <input type="checkbox" name="weekday" value={d.n} />
                <span>{d.short}</span>
              </label>
            ))}
          </fieldset>
          <WindowFields />
          <div className="field-row">
            <label className="field">
              <span>From · optional</span>
              <input type="date" name="validFrom" />
            </label>
            <label className="field">
              <span>Until · optional</span>
              <input type="date" name="validTo" />
            </label>
          </div>
          <SubmitButton pending="Saving" className="btn btn-cyan btn-sm">
            Add weekly hours
          </SubmitButton>
        </form>

        <form action={add} className="tb-form" aria-labelledby={`${idPrefix}-op`}>
          <h5 id={`${idPrefix}-op`} className="mono muted">
            Special opening hours
          </h5>
          <p className="muted small">Different hours on one date, instead of the weekly hours.</p>
          <HiddenFields hidden={hidden} extra={{ ...extra, kind: 'DATE_OPEN' }} />
          <label className="field">
            <span>Date</span>
            <input type="date" name="date" required />
          </label>
          <WindowFields />
          <SubmitButton pending="Saving" className="btn btn-cyan btn-sm">
            Add special hours
          </SubmitButton>
        </form>

        <form action={add} className="tb-form" aria-labelledby={`${idPrefix}-cl`}>
          <h5 id={`${idPrefix}-cl`} className="mono muted">
            Closed day
          </h5>
          <p className="muted small">Closed for the whole date, whatever the weekly hours say.</p>
          <HiddenFields hidden={hidden} extra={{ ...extra, kind: 'DATE_CLOSED' }} />
          <label className="field">
            <span>Date</span>
            <input type="date" name="date" required />
          </label>
          <SubmitButton pending="Saving" className="btn btn-cyan btn-sm">
            Close this day
          </SubmitButton>
        </form>

        <form action={add} className="tb-form" aria-labelledby={`${idPrefix}-bo`}>
          <h5 id={`${idPrefix}-bo`} className="mono muted">
            Maintenance or blackout
          </h5>
          <p className="muted small">
            A period when it can’t be used. Times are in{' '}
            <strong>{zone.replaceAll('_', ' ')}</strong>.
          </p>
          <HiddenFields hidden={hidden} extra={extra} />
          <label className="field">
            <span>Kind</span>
            <select name="kind" defaultValue="MAINTENANCE">
              <option value="MAINTENANCE">Maintenance</option>
              <option value="BLACKOUT">Blackout</option>
            </select>
          </label>
          <div className="field-row">
            <label className="field">
              <span>Starts</span>
              <input type="date" name="startDate" required />
            </label>
            <label className="field">
              <span>at</span>
              <input type="time" name="startTime" required step={60} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>Ends · date if different</span>
              <input type="date" name="endDate" />
            </label>
            <label className="field">
              <span>at</span>
              <input type="time" name="endTime" required step={60} />
            </label>
          </div>
          <ReasonField />
          <SubmitButton pending="Saving" className="btn btn-cyan btn-sm">
            Add period
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}

/** When the resource can actually be scheduled, per local day (the API's effective intervals). */
export function Preview({
  days,
  zone,
  heading,
}: {
  days: readonly PreviewDay[] | null;
  zone: string;
  heading: string;
}) {
  return (
    <div className="res-preview">
      <h5 className="mono muted">
        {heading} <span className="muted small">· {zone.replaceAll('_', ' ')}</span>
      </h5>
      {days === null ? (
        <p className="muted small">The preview can’t be loaded right now.</p>
      ) : (
        <ol className="res-days-preview">
          {days.map((d) => (
            <li key={d.date} data-open={d.windows.length > 0}>
              <span className="mono">{d.label}</span>
              <span>{d.windows.length > 0 ? d.windows.join(', ') : 'Not available'}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The resource form; with `resource` it is the edit form and always posts every field. */
export function ResourceForm({
  action,
  hidden,
  typeCode,
  resource,
  competitionZone,
  submit,
}: {
  action: Action;
  hidden: Hidden;
  typeCode: ResourceType;
  resource?: ResourceView;
  competitionZone: string;
  submit: string;
}) {
  const attrs = Object.entries(RESOURCE_TYPE_ATTRIBUTES[typeCode]);
  const value = (key: string) => {
    const v = resource?.attributes[key];
    return v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  };
  const mode = resource?.occupancyMode ?? RESOURCE_TYPE_DEFAULT_OCCUPANCY_MODE[typeCode];
  return (
    <form action={action} className="tb-form res-form">
      <HiddenFields
        hidden={hidden}
        extra={{
          typeCode,
          ...(resource === undefined
            ? {}
            : {
                resourceId: resource.resourceId,
                venueOrganizationId: resource.venueOrganizationId ?? '',
              }),
        }}
      />
      <label className="field">
        <span>Name</span>
        <input
          name="label"
          required
          maxLength={80}
          defaultValue={resource?.label ?? ''}
          placeholder={`${typeLabel(typeCode)} 1`}
        />
      </label>
      {attrs.length > 0 ? (
        <div className="field-row res-attrs">
          {attrs.map(([key, spec]) => {
            const l = ATTRIBUTE_LABEL[key];
            const name = `attr.${key}`;
            const label = <span>{l?.label ?? key} · optional</span>;
            if (spec.kind === 'BOOL' || spec.kind === 'ENUM')
              return (
                <label key={key} className="field">
                  {label}
                  <select name={name} defaultValue={value(key)}>
                    <option value="">Not specified</option>
                    {spec.kind === 'BOOL' ? (
                      <>
                        <option value="true">{l?.yes ?? 'Yes'}</option>
                        <option value="false">{l?.no ?? 'No'}</option>
                      </>
                    ) : (
                      spec.values.map((v) => (
                        <option key={v} value={v}>
                          {l?.values?.[v] ?? v}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              );
            return (
              <label key={key} className="field">
                {label}
                <input
                  name={name}
                  defaultValue={value(key)}
                  {...(spec.kind === 'INT'
                    ? { type: 'number', min: spec.min, max: spec.max, step: 1 }
                    : spec.kind === 'TEXT'
                      ? { maxLength: spec.maxLength }
                      : { inputMode: 'numeric' as const })}
                />
                {l?.hint !== undefined ? <small>{l.hint}</small> : null}
              </label>
            );
          })}
        </div>
      ) : null}
      <label className="field">
        <span>Location · optional</span>
        <input
          name="locationLabel"
          maxLength={120}
          defaultValue={resource?.locationLabel ?? ''}
          placeholder="e.g. North pavilion"
        />
      </label>
      <details className="res-advanced">
        <summary className="small">Advanced</summary>
        <label className="field">
          <span>Capacity</span>
          <input
            name="capacity"
            type="number"
            min={1}
            max={100000}
            step={1}
            defaultValue={resource?.capacity ?? 1}
          />
          <small>How much it holds at once. Leave 1 for a court or lane pair.</small>
        </label>
        <label className="field">
          <span>Use</span>
          <select name="occupancyMode" defaultValue={mode}>
            {(['EXCLUSIVE', 'SHARED'] as const).map((m) => (
              <option key={m} value={m}>
                {OCCUPANCY_LABEL[m].label} — {OCCUPANCY_LABEL[m].detail}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Timezone</span>
          <input
            name="timezone"
            list="res-zones"
            defaultValue={resource?.timezone ?? ''}
            placeholder={`Tournament’s (${competitionZone.replaceAll('_', ' ')})`}
          />
          <small>Only when this resource keeps hours in another timezone.</small>
        </label>
        <label className="field">
          <span>Shared-space keys</span>
          <input
            name="exclusivityKeys"
            defaultValue={resource?.exclusivityKeys.join(', ') ?? ''}
            placeholder="e.g. main-a, main-b"
          />
          <small>
            Resources sharing a key can’t be used at the same time — e.g. a full court and its half
            courts.
          </small>
        </label>
      </details>
      <SubmitButton pending="Saving" className="btn btn-cyan btn-sm">
        {submit}
      </SubmitButton>
    </form>
  );
}

/** Retire or reactivate with a required reason. */
export function StatusForm({
  action,
  hidden,
  resource,
}: {
  action: Action;
  hidden: Hidden;
  resource: ResourceView;
}) {
  const retire = resource.status === 'ACTIVE';
  return (
    <details className="confirm">
      <summary className="btn btn-ghost btn-sm">{retire ? 'Retire' : 'Reactivate'}</summary>
      <form action={action} className="res-confirm">
        <HiddenFields
          hidden={hidden}
          extra={{ resourceId: resource.resourceId, command: retire ? 'retire' : 'reactivate' }}
        />
        <span className="small">
          {retire
            ? `Retire ${resource.label}? Scheduling stops using it; its history is kept.`
            : `Make ${resource.label} available to scheduling again?`}
        </span>
        <ReasonField />
        <button className={retire ? 'btn btn-danger btn-sm' : 'btn btn-cyan btn-sm'} type="submit">
          {retire ? 'Confirm retirement' : 'Confirm reactivation'}
        </button>
      </form>
    </details>
  );
}

/** Labelled facts about a resource, without technical fields. */
export function ResourceFacts({
  resource,
  zone,
  inherited,
}: {
  resource: ResourceView;
  zone: string;
  inherited: boolean;
}): ReactNode {
  const attrs = Object.entries(resource.attributes);
  return (
    <dl className="res-facts-list">
      <div>
        <dt className="mono muted">Type</dt>
        <dd>{typeLabel(resource.typeCode)}</dd>
      </div>
      <div>
        <dt className="mono muted">Use</dt>
        <dd>
          {OCCUPANCY_LABEL[resource.occupancyMode].label}
          <span className="muted small"> · {OCCUPANCY_LABEL[resource.occupancyMode].detail}</span>
        </dd>
      </div>
      <div>
        <dt className="mono muted">Capacity</dt>
        <dd>{resource.capacity}</dd>
      </div>
      <div>
        <dt className="mono muted">Location</dt>
        <dd>{resource.locationLabel ?? 'Not set'}</dd>
      </div>
      <div>
        <dt className="mono muted">Timezone</dt>
        <dd>
          {zone.replaceAll('_', ' ')}
          {inherited ? <span className="muted small"> · tournament’s</span> : null}
        </dd>
      </div>
      {attrs.map(([k, v]) => (
        <div key={k}>
          <dt className="mono muted">{ATTRIBUTE_LABEL[k]?.label ?? k}</dt>
          <dd>{attributeText(k, v)}</dd>
        </div>
      ))}
    </dl>
  );
}
