import type { ReactNode } from 'react';
import {
  contestNext,
  contestStatusLabel,
  offered,
  slotTime,
  type AttentionItem,
  type CategoryOps,
  type Operation,
  type OpsMatch,
  type RecentItem,
} from '../_lib/operations';
import { STAFF_ROLE_DUTY, STAFF_ROLE_LABEL, type StaffEntry } from '../_lib/staff';
import {
  COMPETITION_STATUS_LABEL,
  EVENT_STATUS_LABEL,
  dateTime,
  instantToZoned,
} from '../_lib/tournament-builder';
import { SubmitButton } from './submit-button';
import { StatusBadge } from './tournament-ui';

/**
 * ONCF-L4 operations workspace pieces. Server-rendered and presentation only: statuses come from
 * the API, and every command is a two-step form — the button opens a confirmation that names the
 * target, its current state and what it becomes. Final operations also need a ticked
 * acknowledgement, and cancel/void a reason; the action checks both again and the API decides.
 */

export type Hidden = { slug: string; competitionId: string };
type Action = (form: FormData) => Promise<never>;

const statusLabel = (target: Operation['target'], s: string) =>
  target === 'match'
    ? contestStatusLabel(s)
    : ((COMPETITION_STATUS_LABEL as Record<string, string>)[s] ??
      (EVENT_STATUS_LABEL as Record<string, string>)[s] ??
      s);

/** One command behind a confirmation. Closing the panel ("Keep as is") changes nothing. */
export function OpsConfirm({
  op,
  action,
  hidden,
  targetId,
  eventId,
  from,
  name,
  warning,
  compact = false,
}: {
  op: Operation;
  action: Action;
  hidden: Hidden;
  targetId: string;
  eventId?: string;
  from: string;
  name: ReactNode;
  warning?: string | null;
  compact?: boolean;
}) {
  const primary = op.tone === 'go';
  return (
    <details className="confirm ops-confirm" data-tone={op.tone} data-command={op.command}>
      <summary
        className={`btn btn-sm ${primary ? 'btn-cyan' : 'btn-ghost'}${compact ? ' ops-more' : ''}`}
      >
        <span className="ops-when-closed">{op.label}</span>
        <span className="ops-when-open">Keep as is</span>
      </summary>
      <form action={action} className="ops-confirm-form">
        <input type="hidden" name="slug" value={hidden.slug} />
        <input type="hidden" name="competitionId" value={hidden.competitionId} />
        <input type="hidden" name="target" value={op.target} />
        <input type="hidden" name="command" value={op.command} />
        <input type="hidden" name="targetId" value={targetId} />
        {eventId !== undefined ? <input type="hidden" name="eventId" value={eventId} /> : null}
        <input type="hidden" name="from" value={from} />
        <p className="ops-confirm-title">
          <strong>{op.label}?</strong> <span>{name}</span>
        </p>
        <p className="ops-transition mono">
          <span>{statusLabel(op.target, from)}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only"> becomes </span>
          <span data-to={op.result}>{statusLabel(op.target, op.result)}</span>
        </p>
        <p className="small">{op.consequence}</p>
        {warning ? (
          <p className="small ops-warning" role="note">
            {warning}
          </p>
        ) : null}
        {op.reason ? (
          <label className="field">
            <span>Reason · required, kept in the record</span>
            <textarea name="reason" required minLength={1} maxLength={500} rows={2} />
          </label>
        ) : null}
        {op.final ? (
          <label className="ops-ack">
            <input type="checkbox" name="confirm" value="yes" required />
            <span>I understand this can’t be undone.</span>
          </label>
        ) : null}
        <SubmitButton
          pending="Working"
          className={`btn btn-sm ${op.tone === 'danger' ? 'btn-danger' : 'btn-cyan'}`}
        >
          {`Confirm · ${op.label.toLowerCase()}`}
        </SubmitButton>
      </form>
    </details>
  );
}

/** A command the lifecycle allows next but that is waiting on something, with the reason. */
export function Blocked({
  label,
  reason,
  href,
}: {
  label: string;
  reason: string;
  href?: string | undefined;
}) {
  return (
    <p className="ops-blocked small">
      <span className="mono">{label}</span> {reason}
      {href !== undefined ? (
        <>
          {' · '}
          <a className="link" href={href}>
            Go there →
          </a>
        </>
      ) : null}
    </p>
  );
}

// ───────────────────────────── attention ─────────────────────────────

export function Attention({ items }: { items: readonly AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section className="ops-attention" aria-labelledby="ops-att-h">
      <h3 id="ops-att-h" className="mono">
        Needs attention <span className="tb-count">{items.length}</span>
      </h3>
      <ul>
        {items.map((i) => (
          <li key={i.key} data-tone={i.tone}>
            <a href={i.href}>
              <strong>{i.label}</strong>
              <span className="muted small">{i.detail}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Real counts of the day's matches; each links to its list. */
export function Pulse({
  live,
  next,
  unscheduled,
  done,
  total,
}: {
  live: number;
  next: number;
  unscheduled: number;
  done: number;
  total: number;
}) {
  const cells: [string, string, number, string?][] = [
    ['live', 'In play', live],
    ['next', 'Up next', next],
    ['unscheduled', 'Not scheduled', unscheduled],
    ['done', 'Done', done, `of ${total}`],
  ];
  return (
    <nav className="ops-pulse" aria-label="Matches at a glance">
      {cells.map(([key, label, n, extra]) => (
        <a key={key} href={`#ops-${key}`} data-key={key} data-zero={n === 0}>
          <span className="mono muted">{label}</span>
          <strong>
            {n}
            {extra !== undefined ? <span className="muted small"> {extra}</span> : null}
          </strong>
        </a>
      ))}
    </nav>
  );
}

// ───────────────────────────── matches ─────────────────────────────

/** The match's local day, when it isn't `today` ("Sun 15 Nov"). */
function otherDay(m: OpsMatch, today: string): string | null {
  if (m.slot === null) return null;
  const d = instantToZoned(m.slot.start, m.slot.zone).slice(0, 10);
  if (d === '' || d === today) return null;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${d}T00:00:00Z`));
}

export function MatchList({
  id,
  title,
  matches,
  permissions,
  action,
  hidden,
  today,
  empty,
  children,
  headless = false,
}: {
  id: string;
  title: string;
  matches: readonly OpsMatch[];
  permissions: readonly string[];
  action: Action;
  hidden: Hidden;
  /** The tournament's local date (YYYY-MM-DD): other days are labelled. */
  today: string;
  empty: string;
  children?: ReactNode;
  /** Inside a fold whose summary already names the list. */
  headless?: boolean;
}) {
  return (
    <section
      id={`ops-${id}`}
      className="ops-section"
      {...(headless ? { 'aria-label': title } : { 'aria-labelledby': `ops-${id}-h` })}
    >
      {headless ? null : (
        <div className="section-head">
          <h3 id={`ops-${id}-h`} className="tb-h3">
            {title} <span className="tb-count">{matches.length}</span>
          </h3>
        </div>
      )}
      {children}
      {matches.length === 0 ? (
        <p className="muted small ops-empty">{empty}</p>
      ) : (
        <ol className="ops-list">
          {matches.map((m) => (
            <MatchRow
              key={m.contestId}
              m={m}
              permissions={permissions}
              action={action}
              hidden={hidden}
              today={today}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

function MatchRow({
  m,
  permissions,
  action,
  hidden,
  today,
}: {
  m: OpsMatch;
  permissions: readonly string[];
  action: Action;
  hidden: Hidden;
  today: string;
}) {
  const ops = offered('match', contestNext(m.status), permissions);
  const start = ops.find((o) => o.command === 'start');
  const runnable = ops.filter((o) => o.tone === 'go' && (o !== start || m.waiting === null));
  const destructive = ops.filter((o) => o.tone === 'danger');
  const time = slotTime(m);
  const day = otherDay(m, today);
  const name = (
    <>
      {m.event.settings.name} · {m.round} · {m.title}
      {m.sides.length > 0 ? ` (${m.sides.join(' vs ')})` : ''}
    </>
  );
  return (
    <li id={`m-${m.contestId}`} className="ops-row" data-status={m.status}>
      <div className="ops-when">
        <span className="mono">{time ?? 'No time'}</span>
        <span className="muted small">
          {[day, m.slot?.court ?? (m.slot === null ? null : 'No court')]
            .filter((x) => x !== null)
            .join(' · ')}
        </span>
      </div>
      <div className="ops-what">
        <strong>{m.sides.length > 0 ? m.sides.join(' vs ') : m.title}</strong>
        <span className="muted small">
          {m.event.settings.name} · {m.round} · {m.title}
        </span>
        {m.status === 'SCHEDULED' && m.waiting !== null ? (
          <span className="ops-wait small" data-kind={m.waiting.kind}>
            {m.waiting.text}
          </span>
        ) : null}
      </div>
      <div className="ops-state">
        <span className="ops-chip" data-status={m.status}>
          {contestStatusLabel(m.status)}
        </span>
      </div>
      {runnable.length > 0 || destructive.length > 0 ? (
        <div className="ops-act">
          {runnable.map((o) => (
            <OpsConfirm
              key={o.command}
              op={o}
              action={action}
              hidden={hidden}
              targetId={m.contestId}
              eventId={m.event.id}
              from={m.status}
              name={name}
            />
          ))}
          {destructive.map((o) => (
            <OpsConfirm
              key={o.command}
              op={o}
              action={action}
              hidden={hidden}
              targetId={m.contestId}
              eventId={m.event.id}
              from={m.status}
              name={name}
              compact
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

// ───────────────────────────── categories ─────────────────────────────

export function CategoryTable({
  categories,
  action,
  hidden,
  base,
}: {
  categories: readonly CategoryOps[];
  action: Action;
  hidden: Hidden;
  base: string;
}) {
  return (
    <ol className="ops-list ops-cats">
      {categories.map((x) => {
        const name = <>{x.event.settings.name}</>;
        const unstarted = x.matches.open - x.matches.live;
        const completeWarning =
          [
            unstarted > 0
              ? `${unstarted} ${unstarted === 1 ? 'match hasn’t' : 'matches haven’t'} started and can’t start afterwards.`
              : '',
            x.matches.live > 0 ? `${x.matches.live} in play can still be finished.` : '',
          ]
            .filter((t) => t !== '')
            .join(' ') || null;
        return (
          <li
            key={x.event.id}
            id={`cat-${x.event.id}`}
            className="ops-row ops-cat"
            data-status={x.event.status}
          >
            <div className="ops-what">
              <strong>
                <a className="link" href={`${base}/categories/${x.event.id}/structure`}>
                  {x.event.settings.name}
                </a>
              </strong>
              <span className="muted small">
                {x.event.discipline.sport.name} · {x.event.format.name}
              </span>
            </div>
            <div className="ops-progress">
              {x.matches.total === 0 ? (
                <span className="muted small">No matches yet</span>
              ) : (
                <>
                  <span className="small">
                    {x.matches.finished}/{x.matches.total} done
                    {x.matches.live > 0 ? ` · ${x.matches.live} in play` : ''}
                  </span>
                  <span className="tb-meter" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.round((x.matches.finished / x.matches.total) * 100)}%`,
                      }}
                    />
                  </span>
                </>
              )}
            </div>
            <div className="ops-state">
              <StatusBadge status={x.event.status} />
            </div>
            <div className="ops-act">
              {x.operations
                .filter((o) => o.tone !== 'danger')
                .map((o) => (
                  <OpsConfirm
                    key={o.command}
                    op={o}
                    action={action}
                    hidden={hidden}
                    targetId={x.event.id}
                    from={x.event.status}
                    name={name}
                    warning={o.command === 'complete' ? completeWarning : null}
                  />
                ))}
              {x.operations
                .filter((o) => o.tone === 'danger')
                .map((o) => (
                  <OpsConfirm
                    key={o.command}
                    op={o}
                    action={action}
                    hidden={hidden}
                    targetId={x.event.id}
                    from={x.event.status}
                    name={name}
                    warning={
                      x.matches.live > 0
                        ? `${x.matches.live} ${x.matches.live === 1 ? 'match is' : 'matches are'} in play: cancelling the category doesn’t stop ${x.matches.live === 1 ? 'it' : 'them'}.`
                        : null
                    }
                    compact
                  />
                ))}
              {x.blocked !== null ? (
                <Blocked label={x.blocked.label} reason={x.blocked.reason} href={x.blocked.href} />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ───────────────────────────── side panels ─────────────────────────────

/** The tournament's explicit staff and what each role can do on this page. */
export function StaffPanel({
  staff,
  staffHref,
}: {
  staff: readonly StaffEntry[] | null;
  staffHref: string;
}) {
  return (
    <section className="tb-panel" aria-labelledby="ops-staff-h">
      <h3 id="ops-staff-h" className="mono muted">
        Staff on this tournament
      </h3>
      {staff === null ? (
        <p className="muted small">The staff list can’t be loaded right now.</p>
      ) : staff.length === 0 ? (
        <p className="muted small">
          Only the organization’s owners and admins. Add schedulers to share the match desk.
        </p>
      ) : (
        <ul className="ops-staff">
          {staff.map((s) => (
            <li key={s.staffId}>
              <strong>{s.athlete?.displayName ?? 'Staff member'}</strong>
              <span className="muted small">
                {STAFF_ROLE_LABEL[s.role]} · {STAFF_ROLE_DUTY[s.role].summary.toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Owners and admins run the tournament and its categories; schedulers start and finish
        matches; only owners and admins cancel or void.{' '}
        <a className="link" href={staffHref}>
          Manage staff →
        </a>
      </p>
    </section>
  );
}

export function RecentPanel({ items, zone }: { items: readonly RecentItem[]; zone: string }) {
  return (
    <section className="tb-panel" aria-labelledby="ops-recent-h">
      <h3 id="ops-recent-h" className="mono muted">
        Latest changes
      </h3>
      {items.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <ol className="ops-recent">
          {items.map((i) => (
            <li key={i.key}>
              <span className="mono muted">{dateTime(i.at, zone) ?? ''}</span>
              <span>
                {i.label} <StatusBadge status={i.status} />
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">
        Tournament and category changes. Match changes show in the lists on the left.
      </p>
    </section>
  );
}
