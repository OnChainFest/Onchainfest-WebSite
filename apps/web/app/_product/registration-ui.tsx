import type { ReactNode } from 'react';
import {
  DECISION_LABEL,
  REGISTRATION_STATUS_LABEL,
  registrationRef,
  type Registration,
  type RegistrationDecision,
  type RegistrationDetail,
  type RegistrationStatus,
} from '../_lib/registrations';
import { dateRange, dateTime, dayParts } from '../_lib/tournament-builder';
import { SubmitButton } from './submit-button';
import { SportGlyph } from './tournament-ui';

/** ONCF-04 presentation pieces for registrations (server-safe, no state, no rules). */

const STATUS_ICON: Record<RegistrationStatus, string> = {
  REQUESTED: '◷',
  WAITLISTED: '⋯',
  CONFIRMED: '✓',
  DECLINED: '✕',
  WITHDRAWN: '↩',
  CANCELLED: '⊘',
};

export function RegistrationStatusChip({
  status,
  size = 'sm',
}: {
  status: RegistrationStatus;
  size?: 'sm' | 'lg';
}) {
  return (
    <span className={`rg-status rg-status-${size} mono`} data-status={status}>
      <span className="rg-icon" aria-hidden="true">
        {STATUS_ICON[status]}
      </span>
      {REGISTRATION_STATUS_LABEL[status]}
    </span>
  );
}

/** Who is entered: a named athlete (visible profile), a team, or a private athlete. */
export function EntrantIdentity({
  r,
  ownSlug,
  link = true,
}: {
  r: Pick<Registration, 'athlete' | 'team' | 'id'>;
  /** The viewer's own athlete address (shown to its owner even when the profile is private). */
  ownSlug?: string;
  link?: boolean;
}) {
  const who =
    r.team !== null
      ? { name: r.team.name, sub: 'Team', named: true }
      : r.athlete !== null
        ? { name: r.athlete.displayName, sub: `@${r.athlete.slug}`, named: true }
        : ownSlug !== undefined
          ? { name: `@${ownSlug}`, sub: 'Your profile', named: true }
          : { name: 'Private athlete', sub: 'Profile not public', named: false };
  const initials =
    who.name
      .replace('@', '')
      .split(/[\s-]+/)
      .filter((w) => w !== '')
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '·';
  return (
    <span className="rg-who">
      <span className="rg-avatar" data-private={!who.named} aria-hidden="true">
        {who.named ? initials : '?'}
      </span>
      <span className="rg-who-text">
        <strong>
          {link && r.athlete !== null ? (
            <a href={`/athletes/${r.athlete.slug}`}>{who.name}</a>
          ) : (
            who.name
          )}
        </strong>
        <span className="mono muted">
          {who.sub} · #{registrationRef(r.id)}
        </span>
      </span>
    </span>
  );
}

/** Ticket-style category card: tournament, category, sport, dates, venue. */
export function EntryTicket({
  r,
  href,
  children,
}: {
  r: Registration;
  href?: string;
  children?: ReactNode;
}) {
  const day = dayParts(r.event.startsAt ?? r.competition.startsAt, r.event.timezone);
  const when =
    dateRange(
      r.event.startsAt ?? r.competition.startsAt,
      r.event.endsAt ?? r.competition.endsAt,
      r.event.timezone,
    ) ?? 'Dates to be announced';
  const body = (
    <>
      <span className="rg-stub" aria-hidden="true">
        <strong>{day?.day ?? '—'}</strong>
        <span className="mono">{day?.month ?? 'TBD'}</span>
      </span>
      <span className="rg-ticket-body">
        <span className="mono muted">{r.competition.name}</span>
        <strong className="rg-ticket-title">{r.event.name}</strong>
        <span className="rg-ticket-meta">
          <SportGlyph code={r.event.sport.code} name={r.event.sport.name} size={22} />
          <span className="muted small">
            {r.event.sport.name} · {r.event.discipline.name} · {r.event.format.name}
          </span>
        </span>
        <span className="muted small">
          {when}
          {r.competition.locationLabel !== null ? ` · ${r.competition.locationLabel}` : ''}
        </span>
      </span>
      <span className="rg-ticket-side">
        <RegistrationStatusChip status={r.status} />
        {children}
      </span>
    </>
  );
  return href === undefined ? (
    <div className="rg-ticket" data-status={r.status}>
      {body}
    </div>
  ) : (
    <a className="rg-ticket" data-status={r.status} href={href}>
      {body}
    </a>
  );
}

/** Status history, oldest first, with the reasons recorded with each step. */
export function RegistrationTimeline({ r }: { r: RegistrationDetail }) {
  return (
    <ol className="rg-timeline" aria-label="Registration history">
      {r.history.map((h, i) => (
        <li
          key={`${h.status}-${h.recordedAt}-${i}`}
          data-status={h.status}
          data-current={i === r.history.length - 1}
        >
          <span className="rg-dot" aria-hidden="true">
            {STATUS_ICON[h.status]}
          </span>
          <span className="rg-step">
            <strong>{REGISTRATION_STATUS_LABEL[h.status]}</strong>
            <span className="mono muted">
              {dateTime(h.recordedAt, r.event.timezone) ?? h.recordedAt}
            </span>
            {h.reason !== null ? <q className="rg-reason">{h.reason}</q> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The decisions the API offers for one registration, as forms. Confirm / waitlist are one click;
 * decline, cancel and withdraw ask for confirmation; decline and cancel take an optional reason the
 * athlete sees (the API's decision command accepts one; withdrawal does not).
 * `hidden` identifies intent only — the server action and the API decide everything.
 */
export function DecisionForms({
  r,
  action,
  hidden,
  keys,
  compact = false,
  full = false,
}: {
  r: Registration;
  action: (form: FormData) => Promise<never>;
  hidden: Record<string, string>;
  /** One idempotency key per offered command, fixed for this render. */
  keys: Record<string, string>;
  compact?: boolean;
  /** The category looks full (display hint; the API decides with CAPACITY_REACHED). */
  full?: boolean;
}) {
  const quick = r.actions.decisions.filter((d) => d === 'CONFIRM' || d === 'WAITLIST');
  const final: (RegistrationDecision | 'WITHDRAW')[] = [
    ...r.actions.decisions.filter((d) => d === 'DECLINE' || d === 'CANCEL'),
    ...(r.actions.withdraw ? (['WITHDRAW'] as const) : []),
  ];
  if (quick.length === 0 && final.length === 0)
    return compact ? null : <p className="muted small">No decisions available in this state.</p>;
  const fields = (command: string) => (
    <>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="registrationId" value={r.id} />
      <input type="hidden" name="command" value={command} />
      <input type="hidden" name="key" value={keys[command] ?? ''} />
    </>
  );
  return (
    <div className={`rg-actions${compact ? ' rg-actions-compact' : ''}`}>
      {quick.map((d) => (
        <form key={d} action={action}>
          {fields(d)}
          <SubmitButton
            pending="Saving"
            className={d === 'CONFIRM' ? 'btn btn-cyan btn-sm' : 'btn btn-ghost btn-sm'}
          >
            {DECISION_LABEL[d]}
            {d === 'CONFIRM' && full ? (
              <span className="sr-only"> (category looks full)</span>
            ) : null}
          </SubmitButton>
        </form>
      ))}
      {final.map((d) => (
        <details key={d} className="confirm rg-confirm">
          <summary className="btn btn-ghost btn-sm">
            {d === 'WITHDRAW' ? 'Withdraw' : DECISION_LABEL[d]}
          </summary>
          <form action={action} className="rg-confirm-form">
            {fields(d)}
            {d === 'WITHDRAW' ? (
              <p className="muted small">Releases the entry’s place. This can’t be undone.</p>
            ) : (
              // The decision command takes an optional reason; withdrawal takes none.
              <label className="field">
                <span>Reason · optional, shown to the athlete</span>
                <textarea name="reason" maxLength={500} rows={2} />
              </label>
            )}
            <button className="btn btn-danger btn-sm" type="submit">
              {d === 'WITHDRAW' ? 'Withdraw entry' : `${DECISION_LABEL[d]} — confirm`}
            </button>
          </form>
        </details>
      ))}
    </div>
  );
}
